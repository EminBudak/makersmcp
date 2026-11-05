import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ArgumentError, buildCommand } from './args.js';
import { FolderBusyError, type Job, type JobManager } from './jobs.js';
import type { InstalledKit, MissingKit, ParamDefinition, ToolDefinition } from './kits.js';
import { errorResult, jobOutputSchema, jobResult, jobStructured } from './results.js';
import { setupReport } from './setup.js';

export interface ToolContext {
  version: string;
  baseDir: string;
  jobs: JobManager;
  /** Every kit that is installed, turned on or not: a tool may use another kit. */
  installed: Map<string, InstalledKit>;
  kits: Array<InstalledKit | MissingKit>;
  enabled: Set<string>;
}

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const DEFAULT_WAIT = 45;

const waitSeconds = z.number().int().min(0).max(600).default(DEFAULT_WAIT)
  .describe('How long to wait for the result before returning a job_id to wait on. 45 is safe for clients that stop a tool call after 60 seconds.');

function paramSchema(param: ParamDefinition): z.ZodType {
  let schema: z.ZodType;
  switch (param.type) {
    case 'url':
      schema = z.string().regex(/^https?:\/\/\S+$/i, 'an address starting with http:// or https://');
      break;
    case 'integer':
    case 'number': {
      let number = param.type === 'integer' ? z.number().int() : z.number();
      if (param.min !== undefined) number = number.min(param.min);
      if (param.max !== undefined) number = number.max(param.max);
      schema = number;
      break;
    }
    case 'boolean':
      schema = z.boolean();
      break;
    case 'enum':
      schema = z.enum(param.values as [string, ...string[]]);
      break;
    case 'list':
      schema = z.array(param.values ? z.enum(param.values as [string, ...string[]]) : z.string().min(1)).min(1);
      break;
    case 'repeat':
      schema = z.array(z.string().min(1)).min(1);
      break;
    default:
      schema = z.string().min(1);
  }
  schema = schema.describe(param.description);
  return param.required ? schema : schema.optional();
}

/** Waits for a job, sending its last line as progress when the client asked for progress. */
async function waitForJob(job: Job, seconds: number, extra: Extra): Promise<void> {
  const progressToken = extra._meta?.progressToken;
  let sentAt = 0;
  const onLine = (line: string) => {
    if (progressToken === undefined || Date.now() - sentAt < 1000) return;
    sentAt = Date.now();
    extra.sendNotification({
      method: 'notifications/progress',
      params: { progressToken, progress: (Date.now() - job.startedAt) / 1000, message: line },
    }).catch(() => {
      // Progress is best effort and never stops the job.
    });
  };
  job.on('line', onLine);
  try {
    await job.wait(seconds * 1000, extra.signal);
  } finally {
    job.off('line', onLine);
  }
}

export function registerKitTool(server: McpServer, context: ToolContext, kit: InstalledKit, tool: ToolDefinition): void {
  const inputSchema: Record<string, z.ZodType> = {};
  for (const [name, param] of Object.entries(tool.params)) inputSchema[name] = paramSchema(param);
  if (tool.out?.flag) {
    inputSchema['out_dir'] = z.string().min(1).optional()
      .describe(`Folder to save into, absolute or relative to ${context.baseDir}. Default: ${tool.out.name}.`);
  }
  inputSchema['wait_seconds'] = waitSeconds;

  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: `${tool.description} (${kit.definition.kit} ${kit.version}, on this machine.)`,
      inputSchema,
      outputSchema: jobOutputSchema,
      annotations: {
        title: tool.title,
        readOnlyHint: tool.readOnly === true,
        destructiveHint: false,
        idempotentHint: tool.readOnly === true,
        openWorldHint: Object.values(tool.params).some(param => param.type === 'url' || param.type === 'url_or_path'),
      },
    },
    async (input: Record<string, unknown>, extra: Extra) => {
      let command;
      try {
        command = buildCommand(tool, input, context);
      } catch (error) {
        if (error instanceof ArgumentError) return errorResult(`## ${tool.title}: not started\n\n${error.message}`);
        throw error;
      }

      let job: Job;
      try {
        job = context.jobs.start({
          kit: kit.definition.kit,
          tool: tool.name,
          title: tool.title,
          script: kit.script,
          args: command.args,
          cwd: context.baseDir,
          folder: command.folder,
          docs: tool.docs,
          check: tool.check,
        });
      } catch (error) {
        if (error instanceof FolderBusyError) {
          return errorResult(`## ${tool.title}: not started\n\n${error.message}. Wait for it with wait_for_job (job_id ${error.job.id}), or give another out_dir.`);
        }
        throw error;
      }

      await waitForJob(job, Number(input['wait_seconds'] ?? DEFAULT_WAIT), extra);
      return jobResult(job);
    },
  );
}

export function registerCoreTools(server: McpServer, context: ToolContext): void {
  const jobId = z.string().min(1).describe('The job_id a makersmcp tool returned.');
  const unknownJob = (id: string) => errorResult(
    `## No job ${id}\n\nJobs last only while this makersmcp runs. list_jobs shows the ones it has.`,
  );

  server.registerTool(
    'wait_for_job',
    {
      title: 'Wait for a job',
      description: 'Waits for a job a makersmcp tool started and returns its result once it ends. If it is still running, call this again with the same job_id. Never start the original tool again to check on a job: that starts a second one.',
      inputSchema: { job_id: jobId, wait_seconds: waitSeconds },
      outputSchema: jobOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ job_id, wait_seconds }, extra) => {
      const job = context.jobs.get(job_id);
      if (!job) return unknownJob(job_id);
      await waitForJob(job, wait_seconds, extra);
      return jobResult(job);
    },
  );

  server.registerTool(
    'cancel_job',
    {
      title: 'Cancel a job',
      description: 'Stops a running job and the browser or ffmpeg it started. Files it already saved stay where they are.',
      inputSchema: { job_id: jobId },
      outputSchema: jobOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ job_id }) => {
      const job = context.jobs.get(job_id);
      if (!job) return unknownJob(job_id);
      await job.cancel();
      return jobResult(job);
    },
  );

  server.registerTool(
    'list_jobs',
    {
      title: 'List jobs',
      description: 'Lists the jobs makersmcp started since it was launched, running or ended, with their folders.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const jobs = context.jobs.list();
      const lines = jobs.map(job => `- ${job.id}: ${job.spec.tool}, ${job.status}, ${job.elapsedSeconds} s`
        + (job.spec.folder ? `, ${job.spec.folder}` : ''));
      return {
        content: [{ type: 'text', text: lines.length ? `## Jobs\n\n${lines.join('\n')}` : 'No jobs yet.' }],
        structuredContent: { jobs: jobs.map(job => jobStructured(job)) },
      };
    },
  );

  server.registerTool(
    'check_setup',
    {
      title: 'Check the setup',
      description: 'Shows which kits makersmcp has and their versions, whether Chrome and ffmpeg were found, and where files are saved. Use it when a tool is missing or a kit fails to start.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => ({
      content: [{ type: 'text', text: setupReport(context) }],
    }),
  );
}

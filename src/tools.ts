import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { NotStartedError, type AvailableKit, type JobView, type KitBackend } from './backend.js';
import type { ParamDefinition, ToolDefinition } from './kits.js';
import { errorResult, jobOutputSchema, jobResult, jobStructured } from './results.js';

export interface ToolContext {
  version: string;
  backend: KitBackend;
  /** A local backend's folder, for the out_dir description. */
  baseDir?: string;
  /** The kits this server turned on. */
  enabled: Set<string>;
}

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const DEFAULT_WAIT = 45;

const waitSeconds = z.number().int().min(0).max(600).default(DEFAULT_WAIT)
  .describe('How long to wait for the result before returning a job_id to wait on. 45 is safe for clients that stop a tool call after 60 seconds.');

// A hosted kit cannot read the agent's disk: a file comes as a link, or as a file an
// earlier job of the same user saved.
const HOSTED_FILE_SOURCE = '(https?:\\/\\/\\S+|job:[^\\s/]+\\/\\S+)';
const HOSTED_FILE = new RegExp(`^${HOSTED_FILE_SOURCE}$`, 'i');
const HOSTED_FILE_HELP = ' Give an https link to the file, or job:<job_id>/<path> for a file an earlier job saved.';
const HOSTED_TEXT_OR_FILE_HELP = ' For a file, give an https link to it, or job:<job_id>/<path> for a file an earlier job saved.';

function paramSchema(param: ParamDefinition, where: KitBackend['where']): z.ZodType {
  let schema: z.ZodType;
  let description = param.description;
  switch (param.type) {
    case 'url':
      schema = z.string().regex(/^https?:\/\/\S+$/i, 'an address starting with http:// or https://');
      break;
    case 'path':
    case 'url_or_path':
      if (where === 'hosted') {
        schema = z.string().regex(HOSTED_FILE, 'an https link, or job:<job_id>/<path>');
        description += HOSTED_FILE_HELP;
      } else {
        schema = z.string().min(1);
      }
      break;
    case 'text_or_path':
      if (where === 'hosted') {
        // The text as the kit takes it, or a file the service brings in. Never a path on its disk.
        schema = z.string().regex(
          new RegExp(`^(?:${param.pattern})$|^${HOSTED_FILE_SOURCE}$`, 'i'),
          'the text itself, an https link, or job:<job_id>/<path>',
        );
        description += HOSTED_TEXT_OR_FILE_HELP;
      } else {
        schema = z.string().min(1);
      }
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
  schema = schema.describe(description);
  return param.required ? schema : schema.optional();
}

/** Waits for a job, sending its progress lines when the client asked for progress. */
function waitFor(context: ToolContext, id: string, seconds: number, extra: Extra): Promise<JobView | undefined> {
  const progressToken = extra._meta?.progressToken;
  const startedAt = Date.now();
  let sentAt = 0;
  const onLine = progressToken === undefined ? undefined : (line: string) => {
    if (Date.now() - sentAt < 1000) return;
    sentAt = Date.now();
    extra.sendNotification({
      method: 'notifications/progress',
      params: { progressToken, progress: (Date.now() - startedAt) / 1000, message: line },
    }).catch(() => {
      // Progress is best effort and never stops the job.
    });
  };
  return context.backend.wait(id, seconds, { signal: extra.signal, onLine });
}

export function registerKitTool(server: McpServer, context: ToolContext, kit: AvailableKit, tool: ToolDefinition): void {
  const { backend } = context;
  const inputSchema: Record<string, z.ZodType> = {};
  for (const [name, param] of Object.entries(tool.params)) inputSchema[name] = paramSchema(param, backend.where);
  if (tool.out?.flag && backend.where === 'local') {
    inputSchema['out_dir'] = z.string().min(1).optional()
      .describe(`Folder to save into, absolute or relative to ${context.baseDir}. Default: ${tool.out.name}.`);
  }
  inputSchema['wait_seconds'] = waitSeconds;
  const place = backend.place ?? (backend.where === 'local' ? 'on this machine' : 'on a server');

  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: `${tool.description} (${kit.definition.kit} ${kit.version}, ${place}.)`,
      inputSchema,
      outputSchema: jobOutputSchema,
      annotations: {
        title: tool.title,
        readOnlyHint: tool.readOnly === true,
        destructiveHint: false,
        idempotentHint: tool.readOnly === true,
        openWorldHint: backend.where === 'hosted'
          || Object.values(tool.params).some(param => param.type === 'url' || param.type === 'url_or_path'),
      },
    },
    async (input: Record<string, unknown>, extra: Extra) => {
      const { wait_seconds: wait, ...args } = input;
      let view: JobView;
      try {
        view = await backend.start({ kit, tool, input: args });
      } catch (error) {
        if (error instanceof NotStartedError) return errorResult(`## ${tool.title}: not started\n\n${error.message}`);
        throw error;
      }
      if (view.status === 'running') {
        view = (await waitFor(context, view.id, Number(wait ?? DEFAULT_WAIT), extra)) ?? view;
      }
      return jobResult(view);
    },
  );
}

export function registerCoreTools(server: McpServer, context: ToolContext): void {
  const { backend } = context;
  const jobId = z.string().min(1).describe('The job_id a makersmcp tool returned.');
  const unknownJob = (id: string) => errorResult(backend.where === 'local'
    ? `## No job ${id}\n\nJobs last only while this makersmcp runs. list_jobs shows the ones it has.`
    : `## No job ${id}\n\nlist_jobs shows your jobs.`);

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
      const view = await waitFor(context, job_id, wait_seconds, extra);
      return view ? jobResult(view) : unknownJob(job_id);
    },
  );

  server.registerTool(
    'cancel_job',
    {
      title: 'Cancel a job',
      description: backend.where === 'local'
        ? 'Stops a running job and the browser or ffmpeg it started. Files it already saved stay where they are.'
        : 'Stops a running job. Files it already saved are not kept.',
      inputSchema: { job_id: jobId },
      outputSchema: jobOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ job_id }) => {
      const view = await backend.cancel(job_id);
      return view ? jobResult(view) : unknownJob(job_id);
    },
  );

  server.registerTool(
    'list_jobs',
    {
      title: 'List jobs',
      description: backend.where === 'local'
        ? 'Lists the jobs makersmcp started since it was launched, running or ended, with their folders.'
        : 'Lists your recent jobs, running or ended, newest first.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const jobs = await backend.list();
      const lines = jobs.map(view => `- ${view.id}: ${view.tool}, ${view.status}, ${view.elapsedSeconds} s`
        + (view.folder ? `, ${view.folder}` : ''));
      return {
        content: [{ type: 'text', text: lines.length ? `## Jobs\n\n${lines.join('\n')}` : 'No jobs yet.' }],
        structuredContent: { jobs: jobs.map(view => jobStructured(view)) },
      };
    },
  );

  server.registerTool(
    'check_setup',
    {
      title: 'Check the setup',
      description: backend.where === 'local'
        ? 'Shows which kits makersmcp has and their versions, whether Chrome and ffmpeg were found, and where files are saved. Use it when a tool is missing or a kit fails to start.'
        : 'Shows which kits are running and their versions, and how long files are kept. Use it when a tool is missing.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => ({
      content: [{ type: 'text', text: await backend.setupReport({ version: context.version, enabled: context.enabled }) }],
    }),
  );
}

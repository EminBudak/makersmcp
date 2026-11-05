import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isAvailable, type AvailableKit, type KitBackend } from './backend.js';
import { loadKitDefinitions, type KitDefinition } from './kits.js';
import { LocalBackend } from './local-backend.js';
import { withDraft2020 } from './schema-dialect.js';
import { defaultOutDir } from './setup.js';
import { registerCoreTools, registerKitTool, type ToolContext } from './tools.js';

export { loadKitDefinitions, resolveKit, validateKitDefinition, KITS_DIR } from './kits.js';
export type {
  InstalledKit,
  KitDefinition,
  MissingKit,
  OutDefinition,
  ParamDefinition,
  ParamType,
  ToolDefinition,
} from './kits.js';
export { JobManager, Job, FolderBusyError } from './jobs.js';
export type { JobSpec } from './jobs.js';
export { ArgumentError, buildCommand } from './args.js';
export { LocalBackend, listFiles, readDocs, viewJob } from './local-backend.js';
export type { LocalBackendOptions } from './local-backend.js';
export { NotStartedError, isAvailable } from './backend.js';
export type {
  AvailableKit,
  JobDoc,
  JobFile,
  JobStatus,
  JobView,
  KitBackend,
  SetupOptions,
  StartRequest,
  UnavailableKit,
  WaitOptions,
} from './backend.js';

const require = createRequire(import.meta.url);
export const version = (require('../package.json') as { version: string }).version;

export interface MakersMcpOptions {
  /** Turn on only these kits. Empty, or with "all" in it: every kit the backend can run. */
  kits?: string[];
  /** Where kits save, and what relative paths are read from. For the local backend. */
  outDir?: string;
  /** A kit's folder to use instead of its installed package, like { musicfit: '../musicfit' }. For the local backend. */
  kitPaths?: Record<string, string>;
  /** Kit definitions to use instead of the ones in kits/. */
  definitions?: KitDefinition[];
  /** Where the jobs run. Default: a LocalBackend on outDir and kitPaths. */
  backend?: KitBackend;
}

interface Prepared {
  context: ToolContext;
  available: AvailableKit[];
}

function prepare(options: MakersMcpOptions): Prepared {
  const definitions = options.definitions ?? loadKitDefinitions();
  const names = new Set<string>();
  for (const definition of definitions) {
    for (const tool of definition.tools) {
      if (names.has(tool.name)) throw new Error(`Two kits have a tool named ${tool.name}`);
      names.add(tool.name);
    }
  }

  // No kits, or "all" among them, turns on every kit the backend can run.
  const asked = (options.kits ?? []).map(kit => kit.trim()).filter(Boolean);
  const all = asked.length === 0 || asked.some(kit => kit.toLowerCase() === 'all');
  const known = new Set(definitions.map(definition => definition.kit));
  const unknown = all ? [] : asked.filter(kit => !known.has(kit));
  if (unknown.length) {
    throw new Error(`Unknown kit: ${unknown.join(', ')}. The kits are ${[...known].join(', ')}, or all.`);
  }

  const local = options.backend
    ? undefined
    : new LocalBackend({ baseDir: options.outDir ?? defaultOutDir(), kitPaths: options.kitPaths });
  const backend = options.backend ?? local!;
  const available = backend.available(definitions).filter(isAvailable);
  const wanted = all ? undefined : new Set(asked);
  const enabled = new Set(available.map(kit => kit.definition.kit).filter(kit => !wanted || wanted.has(kit)));

  return {
    context: { version, backend, baseDir: local?.baseDir, enabled },
    available,
  };
}

/** The setup report that check_setup gives, for `makersmcp --check`. */
export async function describeSetup(options: MakersMcpOptions = {}): Promise<string> {
  const { context } = prepare(options);
  return context.backend.setupReport({ version, enabled: context.enabled });
}

function instructions(context: ToolContext): string {
  if (context.backend.where === 'hosted') {
    return 'MakersMCP runs open source kits for you on its servers: brand kits, fonts, screenshots, '
      + 'demo videos, launch films and more, each from a website or a file. Give files as https links, '
      + 'or as job:<job_id>/<path> for a file an earlier job saved. Every tool returns links to the '
      + 'files it made, which work for a few days, and the kit\'s own notes. A tool that is still working '
      + 'after wait_seconds returns a job_id: call wait_for_job with it, never the same tool again.';
  }
  return 'MakersMCP runs open source kits on this machine: brand kits, fonts, screenshots, '
    + 'demo videos, launch films and more, each from a website or a file. Every tool saves its '
    + `files in a folder (relative ones go under ${context.baseDir}) and returns the folder, the `
    + 'files and the kit\'s own notes. A tool that is still working after wait_seconds returns a '
    + 'job_id: call wait_for_job with it, never the same tool again. check_setup tells what is '
    + 'missing when a tool fails to start.';
}

/**
 * An MCP server with a tool for each tool of each kit the backend can run and the
 * server turned on, plus wait_for_job, cancel_job, list_jobs and check_setup. Connect
 * it to any transport. With the local backend, its running jobs stop when the
 * transport closes.
 */
export function createMcpServer(options: MakersMcpOptions = {}): McpServer {
  const { context, available } = prepare(options);
  const server = new McpServer(
    { name: 'makersmcp', title: 'MakersMCP', version, websiteUrl: 'https://makersmcp.com' },
    { instructions: instructions(context) },
  );

  for (const kit of available) {
    if (!context.enabled.has(kit.definition.kit)) continue;
    for (const tool of kit.definition.tools) registerKitTool(server, context, kit, tool);
  }
  registerCoreTools(server, context);

  const onclose = server.server.onclose;
  server.server.onclose = () => {
    context.backend.close();
    onclose?.();
  };

  const connect = server.connect.bind(server);
  server.connect = (transport: Transport) => connect(withDraft2020(transport));
  return server;
}

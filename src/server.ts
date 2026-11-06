import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
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
export { ArgumentError, buildCommand, expandHome } from './args.js';
export type { BuiltCommand, CommandContext } from './args.js';
export { LocalBackend, failureText, listFiles, readDocs, viewJob } from './local-backend.js';
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
  /** A kit's folder to use instead of its installed package, like { musicfit: '../musicfit' }; ~ is the home folder. For the local backend. */
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

  const backend = options.backend
    ?? new LocalBackend({ baseDir: options.outDir ?? defaultOutDir(), kitPaths: options.kitPaths });
  const available = backend.available(definitions).filter(isAvailable);
  const wanted = all ? undefined : new Set(asked);
  const enabled = new Set(available.map(kit => kit.definition.kit).filter(kit => !wanted || wanted.has(kit)));

  return {
    context: { version, backend, baseDir: backend instanceof LocalBackend ? backend.baseDir : undefined, enabled },
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
 * it to any transport. With the local backend, its running jobs stop when the server
 * or the transport closes, and with this process. On stdio, use serveStdio: the stdio
 * transport does not close when the client goes away.
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

const EXIT_SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const;
// A client sends SIGTERM 2 s after it closes stdin, and SIGKILL 2 s after that.
const DRAIN_MS = 1000;
const EXIT_MS = 1500;

/**
 * Serves makersmcp on this process's stdin and stdout, the way an MCP client starts it,
 * and ends the process once the client is gone: when stdin ends (after answering the
 * requests already sent, for up to a second), when stdout breaks, or on SIGTERM, SIGINT
 * or SIGHUP. The running jobs stop with it. The stdio transport alone never notices the
 * client leave, so a server on stdio should start this way.
 */
export async function serveStdio(options: MakersMcpOptions = {}): Promise<McpServer> {
  const server = createMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // The requests the client still waits on, so one that closes stdin right after its
  // last request still gets the answer.
  const waiting = new Set<string | number>();
  let drained: (() => void) | undefined;
  const receive = transport.onmessage;
  transport.onmessage = (message: JSONRPCMessage) => {
    if ('method' in message && 'id' in message) waiting.add(message.id);
    receive?.(message);
  };
  const send = transport.send.bind(transport);
  transport.send = async (message: JSONRPCMessage) => {
    try {
      await send(message);
    } finally {
      if (!('method' in message) && 'id' in message && message.id !== undefined && waiting.delete(message.id) && !waiting.size) {
        drained?.();
      }
    }
  };

  let closing = false;
  const close = (code: number, drain: boolean) => {
    if (closing) return;
    closing = true;
    const exit = () => process.exit(code);
    setTimeout(exit, EXIT_MS).unref();
    let stopped = false;
    // Closing the server stops the jobs. Their supervisors also stop them once this
    // process is gone, so it need not wait for them.
    const stop = () => {
      if (stopped) return;
      stopped = true;
      server.close().then(exit, exit);
    };
    if (drain && waiting.size) {
      drained = stop;
      setTimeout(stop, DRAIN_MS).unref();
    } else {
      stop();
    }
  };
  process.stdin.on('end', () => close(0, true));
  process.stdin.on('close', () => close(0, true));
  process.stdout.on('error', () => close(0, false));
  for (const [signal, number] of Object.entries(EXIT_SIGNALS)) process.on(signal, () => close(128 + number, false));
  return server;
}

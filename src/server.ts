import { createRequire } from 'node:module';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JobManager } from './jobs.js';
import {
  isInstalled,
  loadKitDefinitions,
  resolveKit,
  type InstalledKit,
  type KitDefinition,
} from './kits.js';
import { withDraft2020 } from './schema-dialect.js';
import { defaultOutDir, setupReport } from './setup.js';
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
export { JobManager } from './jobs.js';

const require = createRequire(import.meta.url);
export const version = (require('../package.json') as { version: string }).version;

export interface MakersMcpOptions {
  /** Turn on only these kits. Default: every kit that is installed. */
  kits?: string[];
  /** Where kits save, and what relative paths are read from. */
  outDir?: string;
  /** A kit's folder to use instead of its installed package, like { musicfit: '../musicfit' }. */
  kitPaths?: Record<string, string>;
  /** Kit definitions to use instead of the ones in kits/. */
  definitions?: KitDefinition[];
}

function prepare(options: MakersMcpOptions): ToolContext {
  const definitions = options.definitions ?? loadKitDefinitions();
  const names = new Set<string>();
  for (const definition of definitions) {
    for (const tool of definition.tools) {
      if (names.has(tool.name)) throw new Error(`Two kits have a tool named ${tool.name}`);
      names.add(tool.name);
    }
  }

  const known = new Set(definitions.map(definition => definition.kit));
  const unknown = (options.kits ?? []).filter(kit => !known.has(kit));
  if (unknown.length) {
    throw new Error(`Unknown kit: ${unknown.join(', ')}. The kits are ${[...known].join(', ')}.`);
  }

  const kits = definitions.map(definition => resolveKit(definition, options.kitPaths));
  const installed = new Map<string, InstalledKit>(
    kits.filter(isInstalled).map(kit => [kit.definition.kit, kit]),
  );
  const wanted = options.kits?.length ? new Set(options.kits) : undefined;
  const enabled = new Set([...installed.keys()].filter(kit => !wanted || wanted.has(kit)));

  return {
    version,
    baseDir: path.resolve(options.outDir ?? defaultOutDir()),
    jobs: new JobManager(),
    installed,
    kits,
    enabled,
  };
}

/** The setup report that check_setup gives, for `makersmcp --check`. */
export function describeSetup(options: MakersMcpOptions = {}): string {
  return setupReport(prepare(options));
}

/**
 * An MCP server with a tool for each tool of each kit that is installed and
 * turned on, plus wait_for_job, cancel_job, list_jobs and check_setup. Connect
 * it to any transport; its running jobs stop when the transport closes.
 */
export function createMcpServer(options: MakersMcpOptions = {}): McpServer {
  const context = prepare(options);
  const server = new McpServer(
    { name: 'makersmcp', title: 'MakersMCP', version, websiteUrl: 'https://makersmcp.com' },
    {
      instructions: 'MakersMCP runs open source kits on this machine: brand kits, fonts, screenshots, '
        + 'demo videos, launch films and more, each from a website or a file. Every tool saves its '
        + `files in a folder (relative ones go under ${context.baseDir}) and returns the folder, the `
        + 'files and the kit\'s own notes. A tool that is still working after wait_seconds returns a '
        + 'job_id: call wait_for_job with it, never the same tool again. check_setup tells what is '
        + 'missing when a tool fails to start.',
    },
  );

  for (const kit of context.installed.values()) {
    if (!context.enabled.has(kit.definition.kit)) continue;
    for (const tool of kit.definition.tools) registerKitTool(server, context, kit, tool);
  }
  registerCoreTools(server, context);

  const onclose = server.server.onclose;
  server.server.onclose = () => {
    context.jobs.closeAll();
    onclose?.();
  };

  const connect = server.connect.bind(server);
  server.connect = (transport: Transport) => connect(withDraft2020(transport));
  return server;
}

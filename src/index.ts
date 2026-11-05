#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer, describeSetup, version, type MakersMcpOptions } from './server.js';

const HELP = `Usage: makersmcp [options]

Runs the MakersMCP server on stdio, for an MCP client like Claude, Cursor,
VS Code or Codex. Every kit that is installed is turned on.

Options:
  --kits <list>        turn on only these kits, like easybrandkit,launch-film
                       (or MAKERSMCP_KITS)
  --out <dir>          where kits save (or MAKERSMCP_OUT; default: the folder
                       makersmcp starts in, or ~/makersmcp)
  --kit-path <k=dir>   use a kit's checkout instead of its package, like
                       musicfit=../musicfit (repeat it, or MAKERSMCP_KIT_PATHS
                       with commas)
  --check              print the kits, Chrome, ffmpeg and the folder, and exit
  -h, --help           show this help
  -v, --version        show the version

Needs Node 22 or newer. The kits need Chrome, Chromium, Edge or Brave, and
ffmpeg for video and sound.`;

function list(text: string | undefined): string[] {
  return (text ?? '').split(',').map(item => item.trim()).filter(Boolean);
}

let parsed;
try {
  parsed = parseArgs({
    options: {
      kits: { type: 'string' },
      out: { type: 'string' },
      'kit-path': { type: 'string', multiple: true },
      check: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  }).values;
} catch (error) {
  console.error(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
  process.exit(2);
}

if (parsed.help) {
  console.log(HELP);
  process.exit(0);
}
if (parsed.version) {
  console.log(version);
  process.exit(0);
}

const kitPaths: Record<string, string> = {};
for (const entry of [...list(process.env['MAKERSMCP_KIT_PATHS']), ...(parsed['kit-path'] ?? [])]) {
  const at = entry.indexOf('=');
  if (at < 1) {
    console.error(`--kit-path ${entry}: write it as kit=folder`);
    process.exit(2);
  }
  kitPaths[entry.slice(0, at)] = entry.slice(at + 1);
}

const options: MakersMcpOptions = {
  kits: list(parsed.kits ?? process.env['MAKERSMCP_KITS']),
  outDir: parsed.out ?? process.env['MAKERSMCP_OUT'],
  kitPaths,
};

try {
  if (parsed.check) {
    console.log(describeSetup(options));
    process.exit(0);
  }
  const server = createMcpServer(options);
  await server.connect(new StdioServerTransport());
  console.error(`makersmcp ${version} running on stdio`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

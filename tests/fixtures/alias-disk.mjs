// plan_launch_film with the real launch-film on a disk that ignores letter case, and with
// --bind through a bind mount, which only a caller that may mount makes (root, or root in
// a user namespace of its own). Each call gives the brand/ folder by another path than the
// one launch-film compares, and prints one JSON line: what the tool said, and whether every
// file it might have deleted is still there, as it was.
// Usage: node alias-disk.mjs <empty folder on a disk that ignores letter case> [--bind]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../dist/server.js';

const base = path.resolve(process.argv[2]);
const bind = process.argv.includes('--bind');
const here = path.dirname(fileURLToPath(import.meta.url));

const write = (file, body) => {
  mkdirSync(path.dirname(path.join(base, file)), { recursive: true });
  writeFileSync(path.join(base, file), body);
};
const kit = { version: 1, name: 'Acme', url: 'https://acme.com', colors: [{ hex: '#112233', role: 'primary' }, { hex: '#ffcc00', role: 'button' }] };
write('words.json', JSON.stringify({
  title: 'Acme widgets', description: 'Acme makes widgets for teams.',
  headings: [{ level: 1, text: 'Widgets for every team' }, { level: 2, text: 'Fast setup' }, { level: 2, text: 'Clear pricing' }],
  ctas: [], paragraphs: [], jsonld: [],
}));
// The team's kit with their notes and logo, and a kit with only its own files.
write('marketing/brand/brand.json', JSON.stringify(kit));
write('marketing/brand/notes.md', '# The team notes\n');
write('marketing/brand/team-logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
write('pure/brand/brand.json', JSON.stringify(kit));

// Every file below a folder with what it holds, to tell whether a call lost any.
const snapshot = folder => {
  const found = {};
  const walk = relative => {
    const full = path.join(base, folder, relative);
    if (!existsSync(full)) return;
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(name);
      else found[name] = readFileSync(path.join(full, entry.name), 'utf8');
    }
  };
  walk('');
  return JSON.stringify(found);
};

const server = createMcpServer({ kits: ['launch-film'], outDir: base, kitPaths: { easybrandkit: path.join(here, 'fake-easybrandkit') } });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: 'alias-disk', version: '1.0.0' });
await client.connect(clientTransport);
const plan = async (name, args, watch) => {
  const before = snapshot(watch);
  const result = await client.callTool({ name: 'plan_launch_film', arguments: { url: 'https://acme.com', words: 'words.json', wait_seconds: 60, ...args } });
  const said = result.content.map(item => item.text).join('\n').split(base).join('<base>');
  process.stdout.write(`${JSON.stringify({ name, status: result.structuredContent?.status ?? 'not started', said, kept: snapshot(watch) === before && before !== '{}' })}\n`);
};

await plan('kit given in other letters', { brand: 'marketing/brand', out_dir: 'Marketing' }, 'marketing/brand');
await plan('kit with only its own files, as its brand.json in other letters', { brand: 'PURE/BRAND/brand.json', out_dir: 'pure' }, 'pure/brand');
await plan('kit given the way out_dir is', { brand: 'Marketing/brand', out_dir: 'Marketing' }, 'marketing/brand');
if (bind) {
  mkdirSync(path.join(base, 'alias'));
  const mounted = spawnSync('mount', ['--bind', path.join(base, 'marketing'), path.join(base, 'alias')], { encoding: 'utf8' });
  if (mounted.status !== 0) throw new Error(`mount --bind failed: ${mounted.stderr}`);
  await plan('kit given through a bind mount', { brand: 'alias/brand', out_dir: 'marketing' }, 'marketing/brand');
  await plan('out_dir through a bind mount', { brand: 'marketing/brand', out_dir: 'alias' }, 'marketing/brand');
}
await client.close();
await server.close();

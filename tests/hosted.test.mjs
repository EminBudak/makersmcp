import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { NotStartedError, createMcpServer, loadKitDefinitions } from '../dist/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');
const definitions = ['fakekit.json', 'otherkit.json']
  .map(file => JSON.parse(readFileSync(path.join(fixtures, file), 'utf8')));

const EXPIRES = Date.UTC(2026, 10, 8, 12, 30) / 1000;

// A backend like a hosted service's: it runs fakekit only, or every kit it is given,
// and keeps its jobs in memory.
class FakeHostedBackend {
  where = 'hosted';
  place = 'on example.com';
  started = [];
  jobs = new Map();
  closed = false;

  constructor({ runs = ['fakekit'] } = {}) {
    this.runs = runs;
  }

  available(kits) {
    return kits.map(definition => this.runs === 'all' || this.runs.includes(definition.kit)
      ? { definition, version: '9.9.9' }
      : { definition, reason: 'not running on example.com right now' });
  }

  async start({ kit, tool, input }) {
    this.started.push({ kit: kit.definition.kit, tool: tool.name, input });
    if (input.url === 'https://busy.example.com/') throw new NotStartedError('Too many jobs today. Try again in 3 hours.');
    const id = `job${this.jobs.size + 1}`;
    const view = {
      id, kit: kit.definition.kit, tool: tool.name, title: tool.title, status: 'running',
      exitCode: null, elapsedSeconds: 0, folder: `${tool.name} ${id}`, lastLine: 'Opening the page',
    };
    this.jobs.set(id, view);
    return view;
  }

  async wait(id, seconds, options = {}) {
    const view = this.jobs.get(id);
    if (!view) return undefined;
    options.onLine?.('Saving the files');
    if (seconds > 0) {
      Object.assign(view, {
        status: 'done', exitCode: 0, elapsedSeconds: 12, summary: 'Saved 2 files.', expiresAt: EXPIRES,
        files: [
          { path: 'REPORT.md', bytes: 120, url: `https://files.example.com/${id}/REPORT.md?s=1` },
          { path: 'logo.svg', bytes: 2048, url: `https://files.example.com/${id}/logo.svg?s=1` },
        ],
        docs: [{ name: 'REPORT.md', text: '# Report\n\nAll good.' }],
      });
      delete view.lastLine;
    }
    return view;
  }

  async cancel(id) {
    const view = this.jobs.get(id);
    if (view) view.status = 'canceled';
    return view;
  }

  async list() {
    return [...this.jobs.values()].reverse();
  }

  setupReport({ version, enabled }) {
    return `hosted ${version}: ${[...enabled].join(', ')}`;
  }

  close() {
    this.closed = true;
  }
}

async function withHosted(callback, { kits = definitions, runs } = {}) {
  const backend = new FakeHostedBackend({ runs });
  const server = createMcpServer({ definitions: kits, backend });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await callback(client, backend);
  } finally {
    await client.close();
    await server.close();
  }
  return backend;
}

// The kits in kits/, as a hosted service lists them.
const withRealKits = callback => withHosted(callback, { kits: loadKitDefinitions(), runs: 'all' });

const text = result => result.content.map(item => item.text).join('\n');

test('a hosted backend gets the kits it runs, no out_dir, and file params that take links', async () => {
  await withHosted(async (client) => {
    const { tools } = await client.listTools();
    const names = tools.map(tool => tool.name);
    assert.ok(names.includes('fake_make') && names.includes('fake_file'));
    assert.ok(!names.includes('other_make'));
    const make = tools.find(tool => tool.name === 'fake_make');
    assert.equal(make.inputSchema.properties.out_dir, undefined);
    assert.match(make.description, /\(fakekit 9\.9\.9, on example\.com\.\)$/);
    assert.equal(make.annotations.openWorldHint, true);
    const file = tools.find(tool => tool.name === 'fake_file').inputSchema.properties.file;
    assert.match(file.description, /job:<job_id>\/<path>/);
    assert.ok(file.pattern);
  });
});

test('a hosted job returns links to its files and when they stop working', async () => {
  await withHosted(async (client, backend) => {
    const result = await client.callTool({ name: 'fake_make', arguments: { url: 'https://example.com/', deep: true } });
    assert.deepEqual(backend.started, [{ kit: 'fakekit', tool: 'fake_make', input: { url: 'https://example.com/', deep: true } }]);
    assert.equal(result.structuredContent.status, 'done');
    assert.equal(result.structuredContent.expires_at, '2026-11-08T12:30:00.000Z');
    assert.equal(result.structuredContent.files[1].url, 'https://files.example.com/job1/logo.svg?s=1');
    assert.match(text(result), /Files, to download until 2026-11-08 12:30 UTC:\n\n- REPORT\.md \(120 B\): https:\/\/files\.example\.com\/job1\/REPORT\.md\?s=1/);
    assert.match(text(result), /### REPORT\.md\n\n# Report\n\nAll good\./);
    assert.doesNotMatch(text(result), /Folder:/);
  });
});

test('a hosted file param refuses a local path, and a job the service refuses is not started', async () => {
  await withHosted(async (client, backend) => {
    const local = await client.callTool({ name: 'fake_file', arguments: { file: '/home/me/film.json' } });
    assert.equal(local.isError, true);
    const linked = await client.callTool({ name: 'fake_file', arguments: { file: 'job:job0/film.json', wait_seconds: 0 } });
    assert.equal(linked.structuredContent.status, 'running');
    assert.deepEqual(linked.structuredContent.next_action, { tool: 'wait_for_job', arguments: { job_id: 'job1' } });

    const busy = await client.callTool({ name: 'fake_make', arguments: { url: 'https://busy.example.com/' } });
    assert.equal(busy.isError, true);
    assert.match(text(busy), /## Fake make: not started\n\nToo many jobs today/);
    assert.equal(backend.started.length, 2);
  });
});

test('the core tools ask the hosted backend, and an unknown job says where to look', async () => {
  const backend = await withHosted(async (client, backend) => {
    await client.callTool({ name: 'fake_make', arguments: { url: 'https://example.com/', wait_seconds: 0 } });
    const waited = await client.callTool({ name: 'wait_for_job', arguments: { job_id: 'job1', wait_seconds: 5 } });
    assert.equal(waited.structuredContent.status, 'done');
    const listed = await client.callTool({ name: 'list_jobs', arguments: {} });
    assert.match(text(listed), /- job1: fake_make, done, 12 s, fake_make job1/);
    const unknown = await client.callTool({ name: 'wait_for_job', arguments: { job_id: 'nope' } });
    assert.equal(unknown.isError, true);
    assert.match(text(unknown), /list_jobs shows your jobs/);
    const setup = await client.callTool({ name: 'check_setup', arguments: {} });
    assert.match(text(setup), /^hosted \d+\.\d+\.\d+: fakekit$/);
    assert.equal(backend.closed, false);
  });
  // Closing the server tells the backend.
  assert.equal(backend.closed, true);
});

test('hosted, a kit param that takes text or a file refuses a path on the server', async () => {
  await withRealKits(async (client, backend) => {
    const refused = [
      ['check_video', { film: 'job:job0/film.mp4', cuts: '/home/someone/.env.production' }],
      ['check_video', { film: 'job:job0/film.mp4', cuts: '../cuts.json' }],
      ['record_demo_video', { url: 'https://example.com', background: '/var/www/site/uploads/private.png' }],
      ['record_demo_video', { url: 'https://example.com', background: 'poster.png' }],
    ];
    for (const [name, args] of refused) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
    }
    assert.equal(backend.started.length, 0, 'no job started');

    const taken = [
      ['check_video', { film: 'job:job0/film.mp4', cuts: '3.2,7.5' }],
      ['check_video', { film: 'job:job0/film.mp4', cuts: 'job:job0/cuts.json' }],
      ['check_video', { film: 'job:job0/film.mp4', cuts: 'https://example.com/cuts.json' }],
      ['record_demo_video', { url: 'https://example.com', background: '#0f172a, #1e293b' }],
      ['record_demo_video', { url: 'https://example.com', background: 'https://example.com/backdrop.png' }],
    ];
    for (const [name, args] of taken) {
      const result = await client.callTool({ name, arguments: { ...args, wait_seconds: 0 } });
      assert.notEqual(result.isError, true, `${name} ${JSON.stringify(args)}: ${text(result)}`);
    }
    assert.equal(backend.started.length, taken.length);

    const { tools } = await client.listTools();
    const cuts = tools.find(entry => entry.name === 'check_video').inputSchema.properties.cuts;
    assert.match(cuts.description, /For a file, give an https link to it, or job:<job_id>\/<path>/);
  });
});

test('hosted, no kit param that names a file is plain text, so none skips the file rules', () => {
  for (const kit of loadKitDefinitions()) {
    for (const entry of kit.tools) {
      for (const [name, param] of Object.entries(entry.params)) {
        if (['string', 'list', 'repeat'].includes(param.type)) {
          assert.doesNotMatch(param.description, /\bfiles?\b/i, `${entry.name}.${name} is ${param.type} but takes a file`);
        }
      }
    }
  }
});

test('hosted, the tool descriptions speak of the server, not of the agent\'s machine or of editing its files', async () => {
  await withRealKits(async client => {
    const { tools } = await client.listTools();
    for (const entry of tools) {
      const texts = [entry.description, ...Object.values(entry.inputSchema.properties ?? {}).map(param => param.description ?? '')];
      for (const words of texts) {
        assert.doesNotMatch(words, /this machine/i, entry.name);
        assert.doesNotMatch(words, /\bedit/i, entry.name);
      }
    }
    const byName = Object.fromEntries(tools.map(entry => [entry.name, entry]));
    assert.match(byName.render_launch_film.description, /^Renders the film\.json of an earlier make_launch_film or plan_launch_film job/);
    assert.match(byName.render_launch_film.inputSchema.properties.film.description, /job:<job_id>\/film\.json/);
    assert.match(byName.plan_launch_film.description, /A film\.json cannot be changed here yet/);
    const source = byName.make_launch_stills.inputSchema.properties.source.description;
    assert.match(source, /job:<job_id>\/film\.json/);
    assert.match(source, /A link is always read as a website\./);
    assert.doesNotMatch(source, /Give an https link to the file/);
    // A manifest link works, since the kit fetches it.
    assert.match(byName.check_pwa_screenshots.inputSchema.properties.manifest.description, /Give an https link to the file/);
  });
});

test('hosted, the instructions do not promise that any file can be a link', async () => {
  await withRealKits(async client => {
    const instructions = client.getInstructions();
    assert.doesNotMatch(instructions, /Give files as https links/);
    // A film.json from a link would come alone, and make_launch_stills reads a link as the website.
    assert.match(instructions, /A file an earlier job saved goes in as job:<job_id>\/<path>, so the files it names come with it: give a film\.json or a brand kit that way\./);
    assert.match(instructions, /a parameter that takes an address or a file reads any link as the address\./);
    assert.doesNotMatch(instructions, /this machine/);
  });
});

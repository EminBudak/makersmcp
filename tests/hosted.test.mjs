import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { NotStartedError, createMcpServer } from '../dist/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');
const definitions = ['fakekit.json', 'otherkit.json']
  .map(file => JSON.parse(readFileSync(path.join(fixtures, file), 'utf8')));

const EXPIRES = Date.UTC(2026, 10, 8, 12, 30) / 1000;

// A backend like a hosted service's: it runs fakekit only and keeps its jobs in memory.
class FakeHostedBackend {
  where = 'hosted';
  place = 'on example.com';
  started = [];
  jobs = new Map();
  closed = false;

  available(kits) {
    return kits.map(definition => definition.kit === 'fakekit'
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

async function withHosted(callback) {
  const backend = new FakeHostedBackend();
  const server = createMcpServer({ definitions, backend });
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

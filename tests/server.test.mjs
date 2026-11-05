import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildCommand } from '../dist/args.js';
import { DRAFT_2020_12 } from '../dist/schema-dialect.js';
import { createMcpServer, loadKitDefinitions, validateKitDefinition } from '../dist/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');
const fakekitDir = path.join(fixtures, 'fakekit');
const definitions = ['fakekit.json', 'otherkit.json']
  .map(file => JSON.parse(readFileSync(path.join(fixtures, file), 'utf8')));

async function withClient(options, callback) {
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'makersmcp-test-'));
  const server = createMcpServer({
    definitions,
    kitPaths: { fakekit: fakekitDir, otherkit: fakekitDir },
    outDir,
    ...options,
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await callback(client, outDir);
  } finally {
    await client.close();
    await server.close();
    rmSync(outDir, { recursive: true, force: true });
  }
}

const text = result => result.content.map(item => item.text).join('\n');

test('the kit definitions in kits/ are valid and their tool names are unique', () => {
  const kits = loadKitDefinitions();
  assert.ok(kits.length >= 4);
  const names = kits.flatMap(kit => kit.tools.map(tool => tool.name));
  assert.equal(new Set(names).size, names.length);
  for (const kit of [...kits, ...definitions]) validateKitDefinition(kit);
});

test('a definition with a parameter the kit cannot receive is refused', () => {
  const broken = structuredClone(definitions[0]);
  broken.tools[0].params.loose = { type: 'string', description: 'No flag and not in args.' };
  assert.throws(() => validateKitDefinition(broken), /needs a flag or a place in args/);
});

test('tools/list has the installed kits, the core tools and 2020-12 schemas', async () => {
  await withClient({}, async client => {
    const { tools } = await client.listTools();
    const names = tools.map(tool => tool.name).sort();
    assert.deepEqual(names, [
      'cancel_job', 'check_setup', 'fake_check', 'fake_file', 'fake_make', 'list_jobs', 'other_make', 'wait_for_job',
    ]);
    for (const tool of tools) assert.equal(tool.inputSchema.$schema, DRAFT_2020_12);
    const make = tools.find(tool => tool.name === 'fake_make');
    assert.ok(make.inputSchema.properties.out_dir);
    assert.equal(make.inputSchema.properties.wait_seconds.default, 45);
    assert.deepEqual(make.inputSchema.required, ['url']);
    assert.equal(tools.find(tool => tool.name === 'fake_check').inputSchema.properties.out_dir, undefined);
  });
});

test('--kits turns on only the kits it names, and an unknown kit is an error', async () => {
  await withClient({ kits: ['otherkit'] }, async client => {
    const names = (await client.listTools()).tools.map(tool => tool.name);
    assert.ok(names.includes('other_make'));
    assert.ok(!names.includes('fake_make'));
  });
  assert.throws(() => createMcpServer({ definitions, kits: ['nokit'] }), /Unknown kit: nokit/);
});

test('a kit that is not installed has no tools, and check_setup says why', async () => {
  await withClient({ kitPaths: { fakekit: fakekitDir } }, async client => {
    const names = (await client.listTools()).tools.map(tool => tool.name);
    assert.ok(!names.includes('other_make'));
    const setup = text(await client.callTool({ name: 'check_setup', arguments: {} }));
    assert.match(setup, /fakekit \(test\): 1\.2\.3, on/);
    assert.match(setup, /otherkit \(test\): not available: the otherkit package is not installed/);
  });
});

test('two kits with the same tool name are refused', () => {
  const twin = structuredClone(definitions[1]);
  twin.kit = 'twin';
  twin.tools[0].name = 'fake_make';
  assert.throws(() => createMcpServer({ definitions: [definitions[0], twin] }), /Two kits have a tool named fake_make/);
});

test('a finished job returns its summary, folder, files and docs', async () => {
  await withClient({}, async (client, outDir) => {
    const result = await client.callTool({
      name: 'fake_make',
      arguments: { url: 'https://www.example.com/', deep: true, plain: false, sizes: ['a', 'b'], page: ['/x', '/y'], theme: 'dark', count: 2 },
    });
    assert.notEqual(result.isError, true);
    const folder = path.join(outDir, 'fakekit-example.com');
    assert.equal(result.structuredContent.status, 'done');
    assert.equal(result.structuredContent.folder, folder);
    assert.deepEqual(result.structuredContent.files.map(file => file.path), [path.join('parts', 'data.json'), 'REPORT.md']);
    assert.match(text(result), /## Fake make: done in \d+ s/);
    assert.match(text(result), /### REPORT\.md\n\n# Report\n\nMade from https:\/\/www\.example\.com\//);
    assert.doesNotMatch(text(result), /MISSING\.md/);
    const args = JSON.parse(/args: (.*)/.exec(text(result))[1]);
    assert.deepEqual(args, [
      'https://www.example.com/', '--deep', '--no-plain', '--sizes', 'a,b', '--page', '/x', '--page', '/y',
      '--theme', 'dark', '--count', '2', '--out', folder, '--with', path.join(fakekitDir, 'fake.js'),
    ]);
  });
});

test('out_dir puts the folder where the agent asks', async () => {
  await withClient({}, async (client, outDir) => {
    const result = await client.callTool({ name: 'fake_make', arguments: { url: 'https://example.com', out_dir: 'mine/brand' } });
    assert.equal(result.structuredContent.folder, path.join(outDir, 'mine', 'brand'));
    assert.ok(existsSync(path.join(outDir, 'mine', 'brand', 'REPORT.md')));
  });
});

test('a failed job is an error with what the kit said', async () => {
  await withClient({}, async client => {
    const result = await client.callTool({ name: 'fake_make', arguments: { url: 'https://fail.example.com' } });
    assert.equal(result.isError, true);
    assert.match(text(result), /failed after \d+ s \(exit code 3\)/);
    assert.match(text(result), /Something broke/);
  });
});

test('arguments the schema refuses never start a job', async () => {
  await withClient({}, async client => {
    const result = await client.callTool({ name: 'fake_make', arguments: { url: 'ftp://example.com' } });
    assert.equal(result.isError, true);
    const jobs = await client.callTool({ name: 'list_jobs', arguments: {} });
    assert.equal(text(jobs), 'No jobs yet.');
  });
});

test('a slow job returns a job_id, and wait_for_job returns its result', async () => {
  await withClient({}, async client => {
    const started = await client.callTool({ name: 'fake_make', arguments: { url: 'https://slow.example.com', wait_seconds: 0 } });
    assert.equal(started.structuredContent.status, 'running');
    const jobId = started.structuredContent.job_id;
    assert.deepEqual(started.structuredContent.next_action, { tool: 'wait_for_job', arguments: { job_id: jobId } });
    assert.match(text(started), /Call wait_for_job/);

    const busy = await client.callTool({ name: 'fake_make', arguments: { url: 'https://slow.example.com', wait_seconds: 0 } });
    assert.equal(busy.isError, true);
    assert.match(text(busy), new RegExp(`${jobId}.*still writing to`));

    const progress = [];
    const done = await client.callTool(
      { name: 'wait_for_job', arguments: { job_id: jobId, wait_seconds: 20 } },
      undefined,
      { onprogress: update => progress.push(update.message) },
    );
    assert.equal(done.structuredContent.status, 'done');
    assert.ok(progress.some(message => /^Working \d+\.\.\.$/.test(message)), `progress: ${progress}`);
  });
});

test('cancel_job stops a running job', async () => {
  await withClient({}, async client => {
    const started = await client.callTool({ name: 'fake_make', arguments: { url: 'https://slow.example.com', wait_seconds: 0 } });
    const canceled = await client.callTool({ name: 'cancel_job', arguments: { job_id: started.structuredContent.job_id } });
    assert.equal(canceled.structuredContent.status, 'canceled');
    const listed = text(await client.callTool({ name: 'list_jobs', arguments: {} }));
    assert.match(listed, /fake_make, canceled/);
  });
});

test('a failed check is a normal result with passed false', async () => {
  await withClient({}, async client => {
    const bad = await client.callTool({ name: 'fake_check', arguments: { url: 'https://bad.example.com' } });
    assert.notEqual(bad.isError, true);
    assert.equal(bad.structuredContent.passed, false);
    assert.match(text(bad), /failed the check/);
    const good = await client.callTool({ name: 'fake_check', arguments: { url: 'https://good.example.com' } });
    assert.equal(good.structuredContent.passed, true);
    assert.match(text(good), /: passed/);
  });
});

test('paths are read from the output folder, and a missing file never starts a job', async () => {
  await withClient({}, async (client, outDir) => {
    const missing = await client.callTool({ name: 'fake_file', arguments: { file: 'nope.json' } });
    assert.equal(missing.isError, true);
    assert.match(text(missing), /there is nothing at .*nope\.json/);

    writeFileSync(path.join(outDir, 'film.json'), '{}');
    const result = await client.callTool({ name: 'fake_file', arguments: { file: 'film.json' } });
    assert.equal(result.structuredContent.folder, outDir);
    assert.deepEqual(JSON.parse(/args: (.*)/.exec(text(result))[1]), [path.join(outDir, 'film.json')]);

    const fromUrl = await client.callTool({ name: 'fake_file', arguments: { file: 'https://example.com/a.json' } });
    assert.equal(fromUrl.structuredContent.folder, path.join(outDir, 'fakekit-example.com'));
  });
});

test('wait_for_job and cancel_job explain an unknown job', async () => {
  await withClient({}, async client => {
    const result = await client.callTool({ name: 'wait_for_job', arguments: { job_id: 'job_nope' } });
    assert.equal(result.isError, true);
    assert.match(text(result), /Jobs last only while this makersmcp runs/);
  });
});

test('{stem:...} and {dir:...} fill folder names from files', () => {
  const tool = {
    name: 'fit',
    title: 'Fit',
    description: 'Fits.',
    args: ['{track}'],
    out: { flag: '--out', name: 'musicfit-{stem:track}' },
    params: { track: { type: 'path', required: true, description: 'A file.' } },
  };
  const baseDir = path.join(fixtures, 'fakekit');
  const command = buildCommand(tool, { track: 'fake.js' }, { baseDir, installed: new Map() });
  assert.deepEqual(command.args, [path.join(baseDir, 'fake.js'), '--out', path.join(baseDir, 'musicfit-fake')]);
});

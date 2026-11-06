import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ArgumentError, buildCommand } from '../dist/args.js';
import { DRAFT_2020_12 } from '../dist/schema-dialect.js';
import {
  LocalBackend, createMcpServer, expandHome, failureText, listFiles, loadKitDefinitions, readDocs, validateKitDefinition,
} from '../dist/server.js';
import { defaultOutDir } from '../dist/setup.js';

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
      'cancel_job', 'check_setup', 'fake_check', 'fake_file', 'fake_make', 'fake_report', 'list_jobs', 'other_make', 'wait_for_job',
    ]);
    for (const tool of tools) assert.equal(tool.inputSchema.$schema, DRAFT_2020_12);
    const make = tools.find(tool => tool.name === 'fake_make');
    assert.ok(make.inputSchema.properties.out_dir);
    assert.equal(make.inputSchema.properties.wait_seconds.default, 45);
    assert.deepEqual(make.inputSchema.required, ['url']);
    assert.equal(tools.find(tool => tool.name === 'fake_check').inputSchema.properties.out_dir, undefined);
  });
});

test('--kits turns on only the kits it names, all or nothing turns on every kit, and an unknown kit is an error', async () => {
  await withClient({ kits: ['otherkit'] }, async client => {
    const names = (await client.listTools()).tools.map(tool => tool.name);
    assert.ok(names.includes('other_make'));
    assert.ok(!names.includes('fake_make'));
  });
  for (const kits of [['all'], ['ALL'], [], ['otherkit', 'all']]) {
    await withClient({ kits }, async client => {
      const names = (await client.listTools()).tools.map(tool => tool.name);
      assert.ok(names.includes('other_make') && names.includes('fake_make'), `kits: ${kits}`);
    });
  }
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
    // A folder's own files come before the files in its subfolders.
    assert.deepEqual(result.structuredContent.files.map(file => file.path), ['REPORT.md', path.join('parts', 'data.json')]);
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

const tool = name => loadKitDefinitions().flatMap(kit => kit.tools).find(entry => entry.name === name);
const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
};
async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await sleep(50);
  }
  return check();
}

test('a folder to save in that is not there yet is made by the first job', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'makersmcp-test-'));
  const outDir = path.join(root, 'not', 'yet');
  try {
    await withClient({ outDir }, async client => {
      const setup = text(await client.callTool({ name: 'check_setup', arguments: {} }));
      assert.match(setup, /It does not exist yet; the first job makes it\./);
      const result = await client.callTool({ name: 'fake_make', arguments: { url: 'https://example.com' } });
      assert.notEqual(result.isError, true, text(result));
      assert.equal(result.structuredContent.status, 'done');
      assert.ok(existsSync(path.join(outDir, 'fakekit-example.com', 'REPORT.md')));
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a folder that cannot be made is a clear error, not a missing node', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'makersmcp-test-'));
  writeFileSync(path.join(root, 'a-file'), 'not a folder');
  const outDir = path.join(root, 'a-file', 'out');
  try {
    await withClient({ outDir }, async client => {
      const setup = text(await client.callTool({ name: 'check_setup', arguments: {} }));
      assert.match(setup, /It does not exist, and it cannot be made in .*a-file/);
      const result = await client.callTool({ name: 'fake_make', arguments: { url: 'https://example.com' } });
      assert.equal(result.isError, true);
      assert.match(text(result), /not started\n\nCannot make .*out, the folder the kits save in: .*Set --out or MAKERSMCP_OUT/);
      assert.doesNotMatch(text(result), /spawn .* ENOENT/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('~ is the home folder in the folder settings and in out_dir', () => {
  assert.equal(expandHome('~'), os.homedir());
  assert.equal(expandHome('~/films'), path.join(os.homedir(), 'films'));
  assert.equal(expandHome('a/~/b'), 'a/~/b');
  assert.equal(new LocalBackend({ baseDir: '~/makersmcp-not-made' }).baseDir, path.join(os.homedir(), 'makersmcp-not-made'));
  assert.ok(!existsSync(path.join(os.homedir(), 'makersmcp-not-made')), 'nothing is made before a job');
  const before = process.env.MAKERSMCP_OUT;
  process.env.MAKERSMCP_OUT = '~/kits-out';
  try {
    assert.equal(defaultOutDir(), path.join(os.homedir(), 'kits-out'));
  } finally {
    if (before === undefined) delete process.env.MAKERSMCP_OUT;
    else process.env.MAKERSMCP_OUT = before;
  }
  const command = buildCommand(definitions[0].tools[0], { url: 'https://example.com', out_dir: '~/brand' }, { baseDir: fixtures, installed: new Map() });
  assert.equal(command.folder, path.join(os.homedir(), 'brand'));
});

test('an argument error keeps the kit\'s reason and leaves out its usage text', async () => {
  await withClient({}, async client => {
    const result = await client.callTool({ name: 'fake_make', arguments: { url: 'https://usage.example.com' } });
    assert.equal(result.isError, true);
    assert.match(text(result), /failed after \d+ s \(exit code 2\)\n\nOpening https:\/\/usage\.example\.com\.\.\.\nfakekit: --count takes 1 to 5\n\nJob ID/);
    assert.doesNotMatch(text(result), /Usage:|--option-/);
    assert.equal(result.structuredContent.last_line, undefined);
  });
});

test('a long log keeps its first lines and its last ones', async () => {
  await withClient({}, async client => {
    const result = await client.callTool({ name: 'fake_make', arguments: { url: 'https://noisy.example.com' } });
    assert.equal(result.isError, true);
    assert.match(text(result), /fakekit: the first step/);
    assert.match(text(result), /\(\d+ more lines\)/);
    assert.match(text(result), /step 60\.\.\.\nfakekit: gave up after step 60/);
  });
  assert.equal(failureText('a\nb\n', 1), 'a\nb');
  // Only an argument error drops what follows a Usage: line.
  assert.equal(failureText('kit: bad value\n\nUsage: kit <url>\n  --x\n', 2), 'kit: bad value');
  assert.equal(failureText('Usage: kit <url>\n', 2), 'Usage: kit <url>');
  assert.equal(failureText('step\nUsage: kit\nkit: broke\n', 1), 'step\nUsage: kit\nkit: broke');
});

test('a check that cannot run is an error, not a failed check', async () => {
  await withClient({}, async client => {
    const broken = await client.callTool({ name: 'fake_check', arguments: { url: 'https://broken.example.com' } });
    assert.equal(broken.isError, true);
    assert.equal(broken.structuredContent.status, 'failed');
    assert.equal(broken.structuredContent.passed, undefined);
    assert.match(text(broken), /fakekit: https:\/\/broken\.example\.com could not be read\nThe check could not run: the kit wrote no report\./);
  });
});

test('a check with a report file counts only a report it wrote this run', async (t) => {
  await withClient({}, async (client, outDir) => {
    const folder = path.join(outDir, 'fakekit-check-broken.example.com');
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, 'REPORT.md'), '# PASS\n\nfrom an earlier run\n');
    const stale = await client.callTool({ name: 'fake_report', arguments: { url: 'https://broken.example.com' } });
    assert.equal(stale.isError, true);
    assert.match(text(stale), /The check could not run: the kit wrote no REPORT\.md\./);
    assert.doesNotMatch(text(stale), /from an earlier run/);

    const bad = await client.callTool({ name: 'fake_report', arguments: { url: 'https://bad.example.com' } });
    assert.notEqual(bad.isError, true);
    assert.equal(bad.structuredContent.passed, false);
    assert.match(text(bad), /failed the check[\s\S]*### REPORT\.md\n\n# FAIL/);

    const good = await client.callTool({ name: 'fake_report', arguments: { url: 'https://good.example.com' } });
    assert.equal(good.structuredContent.passed, true);
  });
});

test('a job lists the files it saved, not what its folder already held', async () => {
  await withClient({}, async (client, outDir) => {
    // A project the agent saves into with out_dir ".".
    const old = Date.now() / 1000 - 3600;
    for (const file of ['.git/HEAD', '.git/objects/ab/cdef', 'node_modules/x/index.js', 'README.md', 'src/app.js']) {
      mkdirSync(path.dirname(path.join(outDir, file)), { recursive: true });
      writeFileSync(path.join(outDir, file), 'x');
      utimesSync(path.join(outDir, file), old, old);
    }
    const result = await client.callTool({ name: 'fake_make', arguments: { url: 'https://example.com', out_dir: '.' } });
    assert.equal(result.structuredContent.folder, outDir);
    assert.deepEqual(result.structuredContent.files.map(file => file.path), ['REPORT.md', path.join('parts', 'data.json')]);
  });
});

test('a file that goes away while a folder is listed is left out', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'makersmcp-test-'));
  writeFileSync(path.join(dir, 'gone.lock'), 'x');
  writeFileSync(path.join(dir, 'kept.txt'), 'x');
  mkdirSync(path.join(dir, 'NOTES.md'));
  const { statSync } = fs;
  fs.statSync = (file, ...rest) => {
    if (String(file).endsWith('gone.lock')) throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${file}'`), { code: 'ENOENT' });
    return statSync(file, ...rest);
  };
  syncBuiltinESMExports();
  try {
    assert.deepEqual(listFiles(dir).map(file => file.path), ['kept.txt']);
    assert.deepEqual(readDocs(dir, ['NOTES.md', 'kept.txt']).map(doc => doc.name), ['kept.txt']);
  } finally {
    fs.statSync = statSync;
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('closing the server stops a running kit and the processes it started', async () => {
  let pids;
  await withClient({}, async (client, outDir) => {
    const started = await client.callTool({ name: 'fake_make', arguments: { url: 'https://tree.example.com', wait_seconds: 0 } });
    assert.equal(started.structuredContent.status, 'running');
    const file = path.join(outDir, 'fakekit-tree.example.com', 'pids.json');
    assert.ok(await until(() => existsSync(file)), 'the kit started its browser');
    pids = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(alive(pids.kit) && alive(pids.browser));
  });
  try {
    assert.ok(await until(() => !alive(pids.kit) && !alive(pids.browser)), 'the kit and its browser are gone');
  } finally {
    for (const pid of Object.values(pids)) if (alive(pid)) process.kill(pid, 'SIGKILL');
  }
});

test('with a file instead of a website, make_launch_stills saves next to it and refuses another out_dir', () => {
  const stills = tool('make_launch_stills');
  const baseDir = mkdtempSync(path.join(os.tmpdir(), 'makersmcp-test-'));
  try {
    mkdirSync(path.join(baseDir, 'project'));
    writeFileSync(path.join(baseDir, 'project', 'film.json'), '{}');
    const context = { baseDir, installed: new Map() };
    const film = path.join(baseDir, 'project', 'film.json');
    assert.throws(
      () => buildCommand(stills, { source: 'project/film.json', out_dir: 'stills-here' }, context),
      error => error instanceof ArgumentError && /out_dir: with these arguments make_launch_stills saves in .*project and cannot save anywhere else/.test(error.message),
    );
    for (const input of [{ source: 'project/film.json' }, { source: 'project/film.json', out_dir: 'project' }]) {
      const command = buildCommand(stills, input, context);
      assert.equal(command.folder, path.join(baseDir, 'project'));
      assert.deepEqual(command.args, ['stills', film]);
    }
    const site = buildCommand(stills, { source: 'https://linear.app', out_dir: 'stills-here' }, context);
    assert.deepEqual(site.args, ['stills', 'https://linear.app', '--out', path.join(baseDir, 'stills-here')]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('an address without https:// is not taken for a missing file without saying so', async () => {
  await withClient({}, async client => {
    const result = await client.callTool({ name: 'fake_file', arguments: { file: 'linear.app' } });
    assert.equal(result.isError, true);
    assert.match(text(result), /there is nothing at .*linear\.app\. A website's address starts with https:\/\/, like https:\/\/linear\.app\./);
  });
});

test('a text_or_path parameter passes its text as it is and a file as a path', () => {
  const baseDir = mkdtempSync(path.join(os.tmpdir(), 'makersmcp-test-'));
  try {
    writeFileSync(path.join(baseDir, 'cuts.json'), '[3.2]');
    writeFileSync(path.join(baseDir, 'film.mp4'), 'x');
    writeFileSync(path.join(baseDir, 'poster.png'), 'x');
    const context = { baseDir, installed: new Map() };
    const check = tool('check_video');
    const cuts = value => buildCommand(check, { film: 'film.mp4', cuts: value }, context).args;
    assert.deepEqual(cuts('3.2, 7.5').slice(2, 4), ['--cuts', '3.2, 7.5']);
    assert.deepEqual(cuts('cuts.json').slice(2, 4), ['--cuts', path.join(baseDir, 'cuts.json')]);
    assert.throws(() => cuts('nope.json'), /cuts: there is nothing at .*nope\.json, and "nope\.json" is not text the kit takes/);
    assert.throws(() => cuts('https://example.com/cuts.json'), /cuts: the kit cannot read a link/);

    const demo = tool('record_demo_video');
    const background = value => buildCommand(demo, { url: 'https://example.com', background: value }, context).args;
    for (const colours of ['#0f172a', 'red, blue', 'rgb(1, 2, 3), #fff', 'HSL(200 50% 40%)', ' #111 , #222 , #333 ']) {
      assert.deepEqual(background(colours).slice(2, 4), ['--background', colours], colours);
    }
    assert.deepEqual(background('poster.png').slice(2, 4), ['--background', path.join(baseDir, 'poster.png')]);
    assert.throws(() => background('/var/www/nope.png'), /background: there is nothing at \/var\/www\/nope\.png/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('a confined backend reads no file and writes no folder outside its own', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'makersmcp-test-'));
  try {
    const baseDir = path.join(root, 'job');
    mkdirSync(path.join(baseDir, 'in'), { recursive: true });
    writeFileSync(path.join(baseDir, 'in', 'film.mp4'), 'x');
    writeFileSync(path.join(root, 'secret.env'), 'DB_PASSWORD=x');
    symlinkSync(path.join(root, 'secret.env'), path.join(baseDir, 'in', 'cuts.json'));
    const context = { baseDir, installed: new Map(), confine: true };
    const check = tool('check_video');
    assert.deepEqual(buildCommand(check, { film: 'in/film.mp4' }, context).args.slice(0, 2), ['check', path.join(baseDir, 'in', 'film.mp4')]);
    assert.throws(() => buildCommand(check, { film: 'in/film.mp4', cuts: '../secret.env' }, context), /cuts: \.\.\/secret\.env is outside/);
    assert.throws(() => buildCommand(check, { film: 'in/film.mp4', cuts: path.join(root, 'secret.env') }, context), /is outside/);
    assert.throws(() => buildCommand(check, { film: 'in/film.mp4', cuts: 'in/cuts.json' }, context), /is outside/);
    assert.throws(() => buildCommand(check, { film: 'in/film.mp4', out_dir: '/tmp/elsewhere' }, context), /out_dir: \/tmp\/elsewhere is outside/);
    // Without confine, the same call reads the file where it is.
    assert.ok(buildCommand(check, { film: 'in/film.mp4', cuts: '../secret.env' }, { baseDir, installed: new Map() }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a tool never replaces a folder that holds files no kit made, or a file added to a kit', () => {
  const plan = tool('plan_launch_film');
  const stills = tool('make_launch_stills');
  const baseDir = mkdtempSync(path.join(os.tmpdir(), 'makersmcp-test-'));
  try {
    const write = (file, body = 'x') => {
      mkdirSync(path.dirname(path.join(baseDir, file)), { recursive: true });
      writeFileSync(path.join(baseDir, file), body);
    };
    // A brand kit the way easybrandkit writes one, and a folder holding it with every file it lists.
    const kit = JSON.stringify({
      version: 1, name: 'Acme',
      logos: [{ file: 'logo-01.png', svg: 'logo-01.svg' }, { file: 'logo-02.png' }],
      screenshots: [{ file: 'screen-01.png' }],
      card: { file: 'card.png' },
      stores: [{ type: 'appstore', assets: [{ file: 'appstore-icon.png' }, { file: 'appstore-shot-01.jpg' }] }, { type: 'x', ok: false }],
    });
    const writeKit = dir => {
      write(`${dir}/brand.json`, kit);
      for (const file of [
        'BRAND.md', '_brand.yml', 'FACTS.md', 'facts.json', 'pages/home.md', 'pages/pricing.md',
        'logo-01.png', 'logo-01.svg', 'logo-02.png', 'screen-01.png', 'card.png', 'appstore-icon.png', 'appstore-shot-01.jpg',
      ]) write(`${dir}/${file}`);
    };
    write('kit/brand.json', kit);
    writeKit('earlier/brand');
    write('earlier/brand/.DS_Store');
    write('project/brand/team-logo.svg');
    write('project/brand/guidelines.md');
    // A brand.json of the team's own, like design tokens, next to their logo.
    write('tokens/brand/brand.json', JSON.stringify({ color: { primary: { value: '#0055ff' } } }));
    write('tokens/brand/team-logo.svg');
    write('broken/brand/brand.json', '{ not json');
    // Earlier kits with something added by hand: a note, a page among the kit's pages, an empty folder.
    writeKit('notes/brand');
    write('notes/brand/our-notes.md');
    writeKit('drafts/brand');
    write('drafts/brand/pages/drafts.md');
    writeKit('nested/brand');
    mkdirSync(path.join(baseDir, 'nested', 'brand', 'print'));
    write('a-file/brand', 'not a folder');
    write('site/brand/acme/brand.json', kit);
    writeKit('words/brand');
    write('words/brand/words.json', '{}');
    // brand/ as a link to a folder elsewhere, and a link to an earlier kit's brand/.
    write('elsewhere/team-logo.svg');
    mkdirSync(path.join(baseDir, 'linked'));
    symlinkSync(path.join(baseDir, 'elsewhere'), path.join(baseDir, 'linked', 'brand'));
    symlinkSync(path.join(baseDir, 'earlier', 'brand'), path.join(baseDir, 'kit-link'));
    mkdirSync(path.join(baseDir, 'empty', 'brand'), { recursive: true });
    write('junk/brand/.DS_Store');
    write('junk/brand/Thumbs.db');
    const context = { baseDir, installed: new Map() };
    const call = (input, which = plan) => buildCommand(which, { url: 'https://acme.com', ...input }, context);

    const refused = [
      [{ brand: 'kit', out_dir: 'project' }, /: plan_launch_film replaces the brand folder in .*project with its own, deleting what is there, and .*project\/brand already holds other files \(no brand\.json in it\)\. Give another out_dir, or move those files first\.$/],
      [{ out_dir: 'project' }, /no brand\.json in it/],
      [{ brand: 'kit', out_dir: 'tokens' }, /and .*tokens\/brand\/brand\.json is not one a kit made \(no "version": 1 in it\)\./],
      [{ brand: 'kit', out_dir: 'broken' }, /and .*broken\/brand\/brand\.json is not one a kit made\./],
      // An App Store page easybrandkit cannot read has launch-film delete brand/ too.
      [{ url: 'https://apps.apple.com/us/app/acme/id1234567890', out_dir: 'tokens' }, /is not one a kit made/],
      // The kit deletes all of brand/, not only the files a kit put there.
      [{ brand: 'kit', out_dir: 'notes' }, /and .*notes\/brand holds our-notes\.md, which its brand\.json does not list\./],
      [{ out_dir: 'notes' }, /holds our-notes\.md, which/],
      [{ brand: 'kit', out_dir: 'drafts' }, /holds pages\/drafts\.md, which/],
      [{ brand: 'kit', out_dir: 'nested' }, /holds print\/, which/],
      [{ brand: 'kit', out_dir: 'a-file' }, /a-file\/brand is a file, not a folder/],
      // The kit to use, or another file the call names, is inside the folder it would delete.
      [{ brand: 'site/brand/acme', out_dir: 'site' }, /and .*site\/brand\/acme is inside it/],
      [{ brand: 'kit', words: 'words/brand/words.json', out_dir: 'words' }, /words\/brand\/words\.json is inside it/],
      [{ brand: 'kit-link', out_dir: 'earlier' }, /kit-link is inside it/],
      // Through a link, what it leads to counts.
      [{ brand: 'kit', out_dir: 'linked' }, /linked\/brand already holds other files/],
    ];
    for (const [input, why] of refused) assert.throws(() => call(input), why, JSON.stringify(input));
    assert.throws(() => call({ source: 'https://acme.com', out_dir: 'notes' }, stills), /: make_launch_stills replaces the brand folder .*holds our-notes\.md/);
    assert.ok(existsSync(path.join(baseDir, 'notes', 'brand', 'our-notes.md')));

    const taken = [
      // An earlier kit with every file it lists, and what a file manager leaves.
      { brand: 'kit', out_dir: 'earlier' },
      { out_dir: 'earlier' },
      { brand: 'kit', out_dir: 'empty' },
      { brand: 'kit', out_dir: 'junk' },
      // The folder itself as the kit, or a file in it: the kit uses it where it is and deletes nothing.
      { brand: 'project/brand', out_dir: 'project' },
      { brand: 'tokens/brand/brand.json', out_dir: 'tokens' },
      { brand: 'notes/brand', words: 'notes/brand/our-notes.md', out_dir: 'notes' },
      { brand: 'kit', out_dir: 'new' },
      { brand: 'kit' },
    ];
    for (const input of taken) assert.ok(call(input).args.includes('--out'), JSON.stringify(input));
    assert.ok(call({ source: 'https://acme.com', out_dir: 'earlier' }, stills).args.includes('--out'));
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('a folder a tool replaces is described well enough to tell a kit\'s from the user\'s', () => {
  const launchFilm = loadKitDefinitions().find(kit => kit.kit === 'launch-film');
  const broken = change => {
    const definition = structuredClone(launchFilm);
    change(definition.tools.find(entry => entry.name === 'plan_launch_film').out);
    return () => validateKitDefinition(definition);
  };
  assert.throws(broken(out => { out.replaces.brand = 'brand.json'; }), /replaces\.brand needs a marker/);
  assert.throws(broken(out => { out.replaces.brand.marker = '../brand.json'; }), /inside the tool's folder/);
  assert.throws(broken(out => { out.replaces.brand.files.push('../../notes.md'); }), /inside the tool's folder/);
  assert.throws(broken(out => { out.replaces.brand.files = 'BRAND.md'; }), /files is a list/);
  assert.throws(broken(out => { out.replaces.brand.version = '1'; }), /version is a number/);
  assert.throws(broken(out => { out.replaces.brand.lists = ['logos[0].file']; }), /lists are places in the marker/);
  assert.throws(broken(out => { out.replaces.brand.from = 'url'; }), /from names a path parameter/);
  assert.throws(broken(out => { delete out.flag; }), /replaces needs out\.flag/);
  broken(() => {})();
});

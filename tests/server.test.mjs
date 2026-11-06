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
  LocalBackend, createMcpServer, expandHome, failureText, listFiles, loadKitDefinitions, readDocs, resolveKit, validateKitDefinition,
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

test('~ is the home folder in a kit path too', { skip: process.platform === 'win32' && 'HOME is not the home folder there' }, () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'makersmcp-home-'));
  const before = process.env.HOME;
  try {
    mkdirSync(path.join(home, 'kits'));
    symlinkSync(fakekitDir, path.join(home, 'kits', 'fakekit'));
    process.env.HOME = home;
    const kit = resolveKit(definitions[0], { fakekit: '~/kits/fakekit' });
    assert.equal(kit.reason, undefined);
    assert.equal(kit.dir, path.join(home, 'kits', 'fakekit'));
    assert.equal(kit.version, '1.2.3');
    const backend = new LocalBackend({ baseDir: home, kitPaths: { fakekit: '~/kits/fakekit' } });
    assert.deepEqual(backend.available([definitions[0]]).map(entry => entry.version), ['1.2.3']);
  } finally {
    if (before === undefined) delete process.env.HOME;
    else process.env.HOME = before;
    rmSync(home, { recursive: true, force: true });
  }
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

// The folders the brand/ guard is tried on: earlier kits, kits with a file added by hand,
// folders of the user's, links, and kit folders to give as brand.
function withBrandFolders(callback) {
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
    // Files of the user's with the names easybrandkit gives a logo and a profile picture.
    writeKit('named/brand');
    write('named/brand/logo-07.png');
    write('named/brand/x-profile.jpg');
    write('a-file/brand', 'not a folder');
    write('site/brand/acme/brand.json', kit);
    writeKit('words/brand');
    write('words/brand/words.json', '{}');
    // brand/ as a link to a folder elsewhere, and a link to an earlier kit's brand/.
    write('elsewhere/team-logo.svg');
    mkdirSync(path.join(baseDir, 'linked'));
    symlinkSync(path.join(baseDir, 'elsewhere'), path.join(baseDir, 'linked', 'brand'));
    symlinkSync(path.join(baseDir, 'earlier', 'brand'), path.join(baseDir, 'kit-link'));
    // brand/ as a link to an earlier kit: deleting it deletes the link, not the kit.
    mkdirSync(path.join(baseDir, 'mirror'));
    symlinkSync(path.join(baseDir, 'earlier', 'brand'), path.join(baseDir, 'mirror', 'brand'));
    mkdirSync(path.join(baseDir, 'empty', 'brand'), { recursive: true });
    write('junk/brand/.DS_Store');
    write('junk/brand/Thumbs.db');
    // A kit folder that holds more than a kit, and brand/ folders launch-film copied it into:
    // as it is, with the note changed since, and through a link, which the copy keeps a link.
    write('kit-with-note/brand.json', kit);
    write('kit-with-note/BRAND.md', '# Acme\n');
    write('kit-with-note/notes.md', '# Kept with the kit\n');
    write('kit-with-note/.gitkeep', '');
    write('kit-with-note/fonts/brand.woff2', 'font');
    fs.cpSync(path.join(baseDir, 'kit-with-note'), path.join(baseDir, 'copies', 'brand'), { recursive: true });
    fs.cpSync(path.join(baseDir, 'kit-with-note'), path.join(baseDir, 'changed', 'brand'), { recursive: true });
    write('changed/brand/notes.md', '# Changed in the film\n');
    symlinkSync(path.join(baseDir, 'kit-with-note'), path.join(baseDir, 'kit-alias'));
    mkdirSync(path.join(baseDir, 'linkcopy'));
    fs.cpSync(path.join(baseDir, 'kit-alias'), path.join(baseDir, 'linkcopy', 'brand'), { recursive: true });
    assert.ok(fs.lstatSync(path.join(baseDir, 'linkcopy', 'brand')).isSymbolicLink());

    const context = { baseDir, installed: new Map() };
    const call = (input, which = tool('plan_launch_film')) => buildCommand(which, { url: 'https://acme.com', ...input }, context);
    callback({ baseDir, call });
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
}

const STORE = 'https://apps.apple.com/us/app/acme/id1234567890';

test('given a brand kit, a tool replaces brand/ only when that holds a kit\'s own files or what the copy brings back', () => {
  withBrandFolders(({ baseDir, call }) => {
    const refused = [
      [{ brand: 'kit', out_dir: 'project' }, /: plan_launch_film replaces the brand folder in .*project with a copy of .*kit, deleting what is there, and .*project\/brand already holds other files \(no brand\.json in it\)\. Give another out_dir, or move those files first\.$/],
      [{ brand: 'kit', out_dir: 'tokens' }, /and .*tokens\/brand\/brand\.json is not one a kit made \(no "version": 1 in it\)\./],
      [{ brand: 'kit', out_dir: 'broken' }, /and .*broken\/brand\/brand\.json is not one a kit made\./],
      // The kit deletes all of brand/, not only the files a kit put there.
      [{ brand: 'kit', out_dir: 'notes' }, /and .*notes\/brand holds our-notes\.md, which its brand\.json does not list and the copy would not bring back\./],
      [{ brand: 'kit', out_dir: 'drafts' }, /holds pages\/drafts\.md, which/],
      [{ brand: 'kit', out_dir: 'nested' }, /holds print\/, which/],
      [{ brand: 'kit', out_dir: 'named' }, /holds logo-07\.png and x-profile\.jpg, which/],
      [{ brand: 'kit', out_dir: 'a-file' }, /a-file\/brand is a file, not a folder/],
      // The kit to use, or another file the call names, is inside the folder it would delete.
      [{ brand: 'site/brand/acme', out_dir: 'site' }, /and .*site\/brand\/acme is inside it/],
      [{ brand: 'kit', words: 'words/brand/words.json', out_dir: 'words' }, /words\/brand\/words\.json is inside it/],
      // The kit given through a link to brand/ is brand/ itself, which the kit would delete before the copy.
      [{ brand: 'kit-link', out_dir: 'earlier' }, /kit-link is that same folder under another name, so it would be gone before the copy\. Give brand as .*earlier\/brand to use it where it is\.$/],
      // A path through a brand/ that is a link leads into the copy once the link is gone.
      [{ brand: 'kit', words: 'mirror/brand/BRAND.md', out_dir: 'mirror' }, /mirror\/brand\/BRAND\.md is inside it/],
      // Through a link, what it leads to counts.
      [{ brand: 'kit', out_dir: 'linked' }, /linked\/brand already holds other files/],
      // A copy brings back only what the kit given holds, as it is.
      [{ brand: 'kit-with-note', out_dir: 'changed' }, /changed\/brand holds notes\.md, which its brand\.json does not list and the copy would not bring back\./],
      [{ brand: 'kit', out_dir: 'copies' }, /copies\/brand holds \.gitkeep, fonts\/ and notes\.md, which/],
      [{ brand: 'kit', out_dir: 'linkcopy' }, /linkcopy\/brand holds \.gitkeep, fonts\/ and notes\.md, which/],
    ];
    for (const [input, why] of refused) assert.throws(() => call(input), why, JSON.stringify(input));
    assert.ok(existsSync(path.join(baseDir, 'notes', 'brand', 'our-notes.md')));

    const taken = [
      // An earlier kit with every file it lists, and what a file manager leaves.
      { brand: 'kit', out_dir: 'earlier' },
      { brand: 'kit', out_dir: 'empty' },
      { brand: 'kit', out_dir: 'junk' },
      { brand: 'kit', out_dir: 'new' },
      { brand: 'kit' },
      // A link to an earlier kit, and a file of that kit named by its own path, which the link's deletion leaves.
      { brand: 'kit', out_dir: 'mirror' },
      { brand: 'kit', words: 'earlier/brand/BRAND.md', out_dir: 'mirror' },
      // The folder itself as the kit, or a file in it: the kit uses it where it is and deletes nothing.
      { brand: 'project/brand', out_dir: 'project' },
      { brand: 'tokens/brand/brand.json', out_dir: 'tokens' },
      { brand: 'notes/brand', words: 'notes/brand/our-notes.md', out_dir: 'notes' },
      // The same kit again: the copy brings back its note, its .gitkeep and its fonts.
      { brand: 'kit-with-note', out_dir: 'copies' },
      { brand: 'kit-with-note/brand.json', out_dir: 'copies' },
      // Given through a link, the copy is that link, and the folder it leads to comes back too.
      { brand: 'kit-alias', out_dir: 'linkcopy' },
      { brand: 'kit-with-note', out_dir: 'linkcopy' },
    ];
    for (const input of taken) assert.ok(call(input).args.includes('--brand'), JSON.stringify(input));
  });
});

test('for an App Store page a tool deletes brand/, so it refuses one that holds files no kit made', () => {
  withBrandFolders(({ call }) => {
    const stills = tool('make_launch_stills');
    const refused = [
      [{ url: STORE, out_dir: 'project' }, /: plan_launch_film replaces the brand folder in .*project with its own for an App Store page, deleting what is there, and .*project\/brand already holds other files \(no brand\.json in it\)\. Give another out_dir, or move those files first\.$/],
      [{ url: STORE, out_dir: 'tokens' }, /tokens\/brand\/brand\.json is not one a kit made/],
      [{ url: STORE, out_dir: 'notes' }, /notes\/brand holds our-notes\.md, which its brand\.json does not list\. Give/],
      [{ url: STORE, out_dir: 'named' }, /named\/brand holds logo-07\.png and x-profile\.jpg, which its brand\.json does not list\./],
      [{ url: STORE, words: 'words/brand/words.json', out_dir: 'words' }, /words\/brand\/words\.json is inside it/],
      // The same page, written the ways launch-film still reads as one.
      [{ url: 'HTTPS://APPS.APPLE.COM/us/app/acme/id1234567890?mt=8', out_dir: 'notes' }, /holds our-notes\.md/],
      [{ url: 'https://itunes.apple.com/gb/app/acme/id123456789', out_dir: 'notes' }, /holds our-notes\.md/],
      [{ url: 'https://apps.apple.com\\us\\app\\acme\\id1234567890', out_dir: 'notes' }, /holds our-notes\.md/],
    ];
    for (const [input, why] of refused) assert.throws(() => call(input), why, JSON.stringify(input));
    assert.throws(() => call({ source: STORE, out_dir: 'notes' }, stills), /: make_launch_stills replaces the brand folder .* for an App Store page, deleting what is there, and .*holds our-notes\.md/);

    for (const out_dir of ['earlier', 'empty', 'junk', 'new']) assert.ok(call({ url: STORE, out_dir }).args.includes('--out'), out_dir);
    assert.ok(call({ source: STORE, out_dir: 'earlier' }, stills).args.includes('--out'));
  });
});

test('for any other address a tool lets easybrandkit make brand/ again where it is, and refuses only a file with a name it writes', () => {
  withBrandFolders(({ call }) => {
    const stills = tool('make_launch_stills');
    // easybrandkit replaces an earlier kit's own files and keeps the rest, and does not
    // start in a folder that holds no kit, so nothing of the user's is lost.
    const taken = [
      { out_dir: 'notes' },
      { out_dir: 'drafts' },
      { out_dir: 'nested' },
      { out_dir: 'earlier' },
      { out_dir: 'project' },
      { out_dir: 'tokens' },
      { out_dir: 'broken' },
      { out_dir: 'linked' },
      { out_dir: 'copies' },
      { words: 'words/brand/words.json', out_dir: 'words' },
      // A Google Play page, and an App Store address that is not an app's page.
      { url: 'https://play.google.com/store/apps/details?id=com.acme', out_dir: 'notes' },
      { url: 'https://apps.apple.com/us/charts/iphone', out_dir: 'notes' },
      { url: 'https://acme.com/apps.apple.com/id1234567890', out_dir: 'notes' },
    ];
    for (const input of taken) assert.ok(call(input).args.includes('--out'), JSON.stringify(input));
    assert.ok(call({ source: 'https://acme.com', out_dir: 'notes' }, stills).args.includes('--out'));

    // A file of the user's named like one easybrandkit writes would be replaced, or deleted when the run fails.
    assert.throws(
      () => call({ out_dir: 'named' }),
      /: plan_launch_film makes the brand folder in .*named again, which replaces a kit's own files there and any file named like one in any letter case, and .*named\/brand holds logo-07\.png and x-profile\.jpg, which its brand\.json does not list\. Give another out_dir, or move those files first\.$/,
    );
    assert.throws(() => call({ source: 'https://acme.com', out_dir: 'named' }, stills), /: make_launch_stills makes the brand folder in .*named again/);
  });
});

// A pattern for a path in a message, as it is written.
const literally = text => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * Runs `callback` while the fs functions makersmcp reads folders with see the files below
 * `baseDir` the way other disks show them: every name in any letter case, as a disk that
 * ignores it does (macOS and Windows, by default), `mounts`, folders shown at a second
 * place, as a bind mount does, or `otherDisks`, folders that are another disk mounted there.
 * No link gives any of them away, and realpath keeps such a path as it is written, as it
 * does there.
 */
function asOnDisk(baseDir, { ignoreCase = false, mounts = {}, otherDisks = [] }, callback) {
  const names = ['existsSync', 'statSync', 'lstatSync', 'readdirSync', 'readFileSync', 'readlinkSync', 'realpathSync'];
  const original = Object.fromEntries(names.map(name => [name, fs[name]]));
  const onDisk = file => {
    if (typeof file !== 'string') return file;
    const relative = path.relative(baseDir, path.resolve(file));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return file;
    let parts = relative.split(path.sep);
    for (const [at, from] of Object.entries(mounts)) {
      const place = at.split('/');
      if (place.every((part, i) => parts[i] === part)) parts = [...from.split('/'), ...parts.slice(place.length)];
    }
    let found = baseDir;
    for (const part of parts) {
      let entries = [];
      try {
        if (ignoreCase) entries = original.readdirSync(found);
      } catch {
        // Not a folder: the name stays as it is written.
      }
      found = path.join(found, entries.find(entry => entry.toLowerCase() === part.toLowerCase()) ?? part);
    }
    return found;
  };
  for (const name of names) fs[name] = (file, ...rest) => original[name](onDisk(file), ...rest);
  fs.realpathSync = (file, ...rest) => {
    const real = original.realpathSync(onDisk(file), ...rest);
    return real === onDisk(file) ? path.resolve(file) : real;
  };
  const onOtherDisk = file => otherDisks.some(at => {
    const relative = path.relative(path.join(baseDir, at), original.realpathSync(onDisk(file)));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
  for (const name of ['statSync', 'lstatSync']) {
    fs[name] = (file, ...rest) => {
      const stats = original[name](onDisk(file), ...rest);
      if (!stats || !onOtherDisk(file)) return stats;
      return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { dev: typeof stats.dev === 'bigint' ? stats.dev + 1n : stats.dev + 1 });
    };
  }
  syncBuiltinESMExports();
  try {
    callback();
  } finally {
    Object.assign(fs, original);
    syncBuiltinESMExports();
  }
}

// For the tests below, more folders next to those of withBrandFolders: put writes a file,
// and kitIn copies the earlier kit into a folder, with the files given added to it.
function addBrandFolders(baseDir) {
  const put = (file, body = 'ours') => {
    mkdirSync(path.dirname(path.join(baseDir, file)), { recursive: true });
    writeFileSync(path.join(baseDir, file), body);
  };
  const kitIn = (dir, more = {}) => {
    fs.cpSync(path.join(baseDir, 'earlier', 'brand'), path.join(baseDir, dir), { recursive: true });
    for (const [file, body] of Object.entries(more)) put(path.join(dir, file), body);
  };
  return { put, kitIn };
}

test('given brand/ itself by another path, a tool refuses to delete it before the copy, and says how to use it where it is', () => {
  withBrandFolders(({ baseDir, call }) => {
    const { kitIn } = addBrandFolders(baseDir);
    kitIn('marketing/brand', { 'notes.md': '# The team notes\n', 'team-logo.svg': '<svg/>' });
    kitIn('pure/brand');
    // A second path to each through a link to the folder above it.
    symlinkSync(path.join(baseDir, 'marketing'), path.join(baseDir, 'alias'));
    symlinkSync(path.join(baseDir, 'pure'), path.join(baseDir, 'pure-alias'));
    const same = (given, use) => new RegExp(`, and ${literally(path.join(baseDir, given))} is that same folder under another name, so it would be gone before the copy\\. Give brand as ${literally(path.join(baseDir, use))} to use it where it is\\.$`);
    for (const [input, given, use] of [
      [{ brand: 'alias/brand', out_dir: 'marketing' }, 'alias/brand', 'marketing/brand'],
      [{ brand: 'alias/brand/brand.json', out_dir: 'marketing' }, 'alias/brand', 'marketing/brand/brand.json'],
      [{ brand: 'marketing/brand', out_dir: 'alias' }, 'marketing/brand', 'alias/brand'],
      // A kit with only its own files would be lost the same way.
      [{ brand: 'pure-alias/brand', out_dir: 'pure' }, 'pure-alias/brand', 'pure/brand'],
    ]) assert.throws(() => call(input), same(given, use), JSON.stringify(input));
    for (const name of ['make_launch_film', 'plan_launch_film']) {
      assert.throws(() => call({ brand: 'alias/brand', out_dir: 'marketing' }, tool(name)), /is that same folder under another name/, name);
    }
    // Given as the refusal says, the kit uses the folder where it is.
    assert.ok(call({ brand: 'marketing/brand', out_dir: 'marketing' }).args.includes('--brand'));
    assert.ok(call({ brand: 'alias/brand', out_dir: 'alias' }).args.includes('--brand'));
  });
});

// The folders both tests below look at through asOnDisk.
function withAliasFolders(callback) {
  withBrandFolders(({ baseDir, call }) => {
    const { kitIn } = addBrandFolders(baseDir);
    kitIn('marketing/brand', { 'notes.md': '# The team notes\n', 'team-logo.svg': '<svg/>', 'old/brand.json': JSON.stringify({ version: 1 }) });
    kitIn('pure/brand');
    // A copy of kit-with-note in which the note has another letter case.
    fs.cpSync(path.join(baseDir, 'kit-with-note'), path.join(baseDir, 'recased', 'brand'), { recursive: true });
    fs.renameSync(path.join(baseDir, 'recased', 'brand', 'notes.md'), path.join(baseDir, 'recased', 'brand', 'Notes.md'));
    callback({ baseDir, call });
  });
}

const SAME = /, and .* is that same folder under another name, so it would be gone before the copy\. Give brand as .* to use it where it is\.$/;

test('on a disk that ignores letter case, brand/ given in other letters is still brand/, and a file in it is still in it', () => {
  withAliasFolders(({ baseDir, call }) => {
    asOnDisk(baseDir, { ignoreCase: true }, () => {
      for (const input of [
        { brand: 'marketing/brand', out_dir: 'Marketing' },
        { brand: 'MARKETING/BRAND', out_dir: 'marketing' },
        { brand: 'Marketing/Brand/brand.json', out_dir: 'marketing' },
        { brand: 'pure/brand', out_dir: 'PURE' },
      ]) assert.throws(() => call(input), SAME, JSON.stringify(input));
      assert.throws(() => call({ brand: 'Marketing/brand/old', out_dir: 'marketing' }), /Marketing\/brand\/old is inside it\. Give another out_dir/);
      // A file the call names is in the folder deleted, however its path is written.
      assert.throws(() => call({ url: STORE, words: 'Earlier/Brand/facts.json', out_dir: 'earlier' }), /Earlier\/Brand\/facts\.json is inside it\./);
      // A copy brings back a file under its very name only.
      assert.throws(() => call({ brand: 'kit-with-note', out_dir: 'recased' }), /recased\/brand holds Notes\.md, which its brand\.json does not list and the copy would not bring back\./);
      assert.ok(call({ brand: 'kit-with-note', out_dir: 'copies' }).args.includes('--brand'));
      assert.ok(call({ brand: 'Marketing/brand', out_dir: 'Marketing' }).args.includes('--brand'));
    });
  });
});

test('through a mount, brand/ given at the other place is still brand/, and a file in it is still in it', () => {
  withAliasFolders(({ baseDir, call }) => {
    asOnDisk(baseDir, { mounts: { alias: 'marketing', 'pure-mount': 'pure', whole: 'marketing/brand', inner: 'marketing/brand/old' } }, () => {
      for (const input of [
        { brand: 'alias/brand', out_dir: 'marketing' },
        { brand: 'marketing/brand', out_dir: 'alias' },
        { brand: 'whole', out_dir: 'marketing' },
        { brand: 'pure-mount/brand/brand.json', out_dir: 'pure' },
      ]) assert.throws(() => call(input), SAME, JSON.stringify(input));
      assert.throws(() => call({ brand: 'inner', out_dir: 'marketing' }), /inner is inside it\./);
      assert.throws(() => call({ url: STORE, words: 'pure-mount/brand/BRAND.md', out_dir: 'pure' }), /pure-mount\/brand\/BRAND\.md is inside it\./);
      assert.ok(call({ url: STORE, out_dir: 'pure' }).args.includes('--out'));
    });
  });
});

test('a tool refuses to copy a kit folder into a folder inside it, which deletes brand/ before the copy fails', () => {
  withBrandFolders(({ baseDir, call }) => {
    const { kitIn } = addBrandFolders(baseDir);
    // A kit folder that holds a film's folder, with a brand/ copied from it before.
    kitIn('big');
    kitIn('big/film/brand');
    symlinkSync(path.join(baseDir, 'big'), path.join(baseDir, 'big-link'));
    const refusal = (dir, kit) => new RegExp(`, and ${literally(path.join(baseDir, dir))} is inside ${literally(path.join(baseDir, kit))}, and a folder cannot be copied into itself\\. Give an out_dir outside ${literally(path.join(baseDir, kit))}\\.$`);
    for (const [input, dir, kit] of [
      [{ brand: 'big', out_dir: 'big/film' }, 'big/film/brand', 'big'],
      [{ brand: 'big/brand.json', out_dir: 'big/new' }, 'big/new/brand', 'big'],
      [{ brand: 'big', out_dir: 'big' }, 'big/brand', 'big'],
      [{ brand: 'big-link', out_dir: 'big/film' }, 'big/film/brand', 'big-link'],
      [{ brand: 'big', out_dir: 'big-link/film' }, 'big-link/film/brand', 'big'],
    ]) assert.throws(() => call(input), refusal(dir, kit), JSON.stringify(input));
    assert.ok(call({ brand: 'big', out_dir: 'elsewhere-film' }).args.includes('--brand'));
  });
});

test('a copy brings back a file by its bytes, a hard link of it too, never by being the same file', () => {
  withBrandFolders(({ baseDir, call }) => {
    fs.cpSync(path.join(baseDir, 'kit-with-note'), path.join(baseDir, 'hardlinked', 'brand'), { recursive: true });
    rmSync(path.join(baseDir, 'hardlinked', 'brand', 'notes.md'));
    fs.linkSync(path.join(baseDir, 'kit-with-note', 'notes.md'), path.join(baseDir, 'hardlinked', 'brand', 'notes.md'));
    assert.ok(call({ brand: 'kit-with-note', out_dir: 'hardlinked' }).args.includes('--brand'));
  });
});

test('from a website, a file named like a kit\'s own in other letters stops the tool, on any disk', () => {
  withBrandFolders(({ baseDir, call }) => {
    const { put, kitIn } = addBrandFolders(baseDir);
    const cases = [
      ['cards', ['Card.png', 'Logo-03.PNG'], 'Card\\.png and Logo-03\\.PNG'],
      ['marks', ['Brand.md', 'FACTS.MD'], 'Brand\\.md and FACTS\\.MD'],
      ['marker', ['Brand.json'], 'Brand\\.json'],
      ['profiles', ['X-Profile.jpg', 'LinkedIn-Icon.PNG'], 'LinkedIn-Icon\\.PNG and X-Profile\\.jpg'],
      ['page-case', ['pages/Home.md', 'pages/ABOUT.md'], 'pages/ABOUT\\.md and pages/Home\\.md'],
      // A folder of the user's where the kit writes a file of its own.
      ['folder-named', [], 'BRAND\\.md/'],
    ];
    for (const [dir, files] of cases) kitIn(`${dir}/brand`, Object.fromEntries(files.map(file => [file, 'ours'])));
    rmSync(path.join(baseDir, 'folder-named', 'brand', 'BRAND.md'));
    put('folder-named/brand/BRAND.md/notes.md');
    for (const [dir, , names] of cases) {
      assert.throws(() => call({ out_dir: dir }), new RegExp(`any file named like one in any letter case, and .*${dir}/brand holds ${names}, which its brand\\.json does not list\\. Give another out_dir`), dir);
      assert.throws(() => call({ source: 'https://acme.com', out_dir: dir }, tool('make_launch_stills')), /holds .*, which its brand\.json does not list/, dir);
    }
    // The kit's own files, as it writes them, and the files of the user's beside them.
    kitIn('own/brand', { 'notes.md': 'ours', 'pages/roadmap.md': 'ours', 'drafts/logo-01.png': 'ours' });
    assert.ok(call({ out_dir: 'own' }).args.includes('--out'));
  });
});

test('from a website, a link, a file or another disk where the kit keeps a folder of its own files stops the tool, in every such folder', () => {
  withBrandFolders(({ baseDir, call }) => {
    const { put, kitIn } = addBrandFolders(baseDir);
    const pages = dir => path.join(baseDir, dir, 'brand', 'pages');
    put('team-pages/home.md', '# Our home page\n');
    put('team-pages/about.md', '# About us\n');
    kitIn('linked-pages/brand');
    rmSync(pages('linked-pages'), { recursive: true });
    symlinkSync(path.join(baseDir, 'team-pages'), pages('linked-pages'));
    kitIn('file-pages/brand');
    rmSync(pages('file-pages'), { recursive: true });
    writeFileSync(pages('file-pages'), 'a file');
    kitIn('case-pages/brand');
    fs.renameSync(pages('case-pages'), path.join(baseDir, 'case-pages', 'brand', 'Pages'));
    for (const [dir, why] of [
      ['linked-pages', 'linked-pages/brand/pages is a link, so the kit would delete files named like its own where it leads'],
      ['file-pages', 'file-pages/brand/pages is a file where the kit keeps its pages folder'],
      ['case-pages', 'case-pages/brand/Pages is named like the kit\'s pages folder in other letters, which a disk that ignores letter case takes for that one'],
    ]) assert.throws(() => call({ out_dir: dir }), new RegExp(`any file named like one in any letter case, and .*${literally(why)}\\. Give another out_dir, or move those files first\\.$`), dir);
    assert.deepEqual(fs.readdirSync(path.join(baseDir, 'team-pages')).sort(), ['about.md', 'home.md']);

    // brand/ itself as a link: the kit makes the kit again where it leads, so the same holds there.
    kitIn('team-kit', { 'notes.md': '# Kept\n' });
    kitIn('team-kit-cased', { 'Card.png': 'ours' });
    for (const [dir, to] of [['shared', 'team-kit'], ['shared-cased', 'team-kit-cased'], ['shared-pages', 'linked-pages/brand']]) {
      mkdirSync(path.join(baseDir, dir));
      symlinkSync(path.join(baseDir, to), path.join(baseDir, dir, 'brand'));
    }
    assert.ok(call({ out_dir: 'shared' }).args.includes('--out'));
    assert.throws(() => call({ out_dir: 'shared-cased' }), /shared-cased\/brand holds Card\.png, which/);
    assert.throws(() => call({ out_dir: 'shared-pages' }), /shared-pages\/brand\/pages is a link/);

    // Any folder the kit keeps files in, as its definition lists them, not only pages/.
    const deep = structuredClone(tool('plan_launch_film'));
    deep.out.replaces.brand.files.push('assets/icons/app.png');
    kitIn('deep/brand', { 'assets/icons/app.png': 'kit', 'assets/notes.md': 'ours' });
    assert.ok(call({ out_dir: 'deep' }, deep).args.includes('--out'));
    kitIn('deep-linked/brand', { 'assets/notes.md': 'ours' });
    symlinkSync(path.join(baseDir, 'team-pages'), path.join(baseDir, 'deep-linked', 'brand', 'assets', 'icons'));
    assert.throws(() => call({ out_dir: 'deep-linked' }, deep), /deep-linked\/brand\/assets\/icons is a link, so the kit would delete files/);
    kitIn('deep-top/brand');
    symlinkSync(path.join(baseDir, 'team-pages'), path.join(baseDir, 'deep-top', 'brand', 'assets'));
    assert.throws(() => call({ out_dir: 'deep-top' }, deep), /deep-top\/brand\/assets is a link, so the kit would delete files/);
    kitIn('deep-cased/brand', { 'assets/icons/App.png': 'ours' });
    assert.throws(() => call({ out_dir: 'deep-cased' }, deep), /deep-cased\/brand holds assets\/icons\/App\.png, which its brand\.json does not list/);

    // Another disk mounted where the kit keeps its pages is another place too; one where brand/ leads is not.
    kitIn('mounted-pages/brand');
    asOnDisk(baseDir, { otherDisks: ['mounted-pages/brand/pages', 'team-kit'] }, () => {
      assert.throws(() => call({ out_dir: 'mounted-pages' }), /mounted-pages\/brand\/pages is another disk mounted there, so the kit would delete files named like its own on it\./);
      assert.ok(call({ out_dir: 'shared' }).args.includes('--out'));
    });
  });
});

test('make_launch_stills takes a value that ends in .json for a film.json, so a link to one is refused and another file is an address', () => {
  const stills = tool('make_launch_stills');
  const baseDir = mkdtempSync(path.join(os.tmpdir(), 'makersmcp-test-'));
  try {
    for (const file of ['film.json', 'FILM.JSON', 'film.txt']) writeFileSync(path.join(baseDir, file), '{}');
    const context = { baseDir, installed: new Map() };
    const call = source => buildCommand(stills, { source }, context);
    for (const source of ['https://example.com/film.json', 'https://example.com/plans/FILM.JSON', 'http://example.com/a.Json']) {
      assert.throws(() => call(source), new RegExp(`: source: the kit takes ${source.replace(/[.?/]/g, '\\$&')} for a file, not for an address, and cannot download one\\. The product's website`), source);
    }
    // A link with a query after .json is read as the website, the way the kit reads it.
    assert.deepEqual(call('https://example.com/film.json?sig=1').args.slice(0, 2), ['stills', 'https://example.com/film.json?sig=1']);
    for (const source of ['film.json', 'FILM.JSON']) assert.deepEqual(call(source).args, ['stills', path.join(baseDir, source)]);
    assert.throws(() => call('film.txt'), /: source: the kit takes .*film\.txt for an address, not for a file\./);
    assert.throws(() => call('nope.json'), /source: there is nothing at .*nope\.json/);

    const broken = change => {
      const definition = structuredClone(loadKitDefinitions().find(kit => kit.kit === 'launch-film'));
      change(definition.tools.find(entry => entry.name === 'make_launch_stills').params);
      return () => validateKitDefinition(definition);
    };
    assert.throws(broken(params => { params.source.filePattern = '(.json'; }), /the filePattern is not a regular expression/);
    assert.throws(broken(params => { params.for.filePattern = '.*'; }), /only url_or_path takes a filePattern/);
    broken(() => {})();
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
  assert.throws(broken(out => { out.replaces.brand.addresses = 'https://apps\\.apple\\.com/.*'; }), /addresses are a pattern, a regular expression, and about/);
  assert.throws(broken(out => { out.replaces.brand.addresses.pattern = '(apps'; }), /addresses are a pattern/);
  assert.throws(broken(out => { delete out.replaces.brand.addresses.about; }), /addresses are a pattern/);
  assert.throws(broken(out => { out.replaces.brand.names = 'logo-(\\d+'; }), /names is a regular expression/);
  assert.throws(broken(out => { delete out.replaces.brand.addresses; }), /names need addresses/);
  broken(() => {})();

  // Addresses need a parameter to give one.
  const definition = structuredClone(launchFilm);
  const plan = definition.tools.find(entry => entry.name === 'plan_launch_film');
  plan.params.url.type = 'string';
  assert.throws(() => validateKitDefinition(definition), /addresses need a parameter that takes an address/);
});

// LocalBackend the way a service runs it: each kit started through a launcher, as one that
// runs kits as another user does, and what a kit left in its folder read without trusting
// it. Another user's processes are stood in for by refusing every signal this process
// sends, the way the system refuses them (EPERM).
import assert from 'node:assert/strict';
import { ChildProcess, spawnSync } from 'node:child_process';
import fs, { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LocalBackend, createMcpServer, isAvailable, listFiles, readDocs } from '../dist/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');
const fakekitDir = path.join(fixtures, 'fakekit');
const fakeScript = path.join(fakekitDir, 'fake.js');
const supervisor = path.join(here, '..', 'dist', 'supervise.js');
const definitions = ['fakekit.json', 'otherkit.json']
  .map(file => JSON.parse(readFileSync(path.join(fixtures, file), 'utf8')));
const kitPaths = { fakekit: fakekitDir, otherkit: fakekitDir };
const notPosix = process.platform === 'win32' && 'the launcher here is a shell script, and the docs use links and a fifo';

const text = result => result.content.map(item => item.text).join('\n');
const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
};
async function until(check, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await sleep(50);
  }
  return check();
}
const groupOf = pid => Number(spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim());
const sh = value => `'${value.replace(/'/g, "'\\''")}'`;

/**
 * A launcher the way sudo and a wrapper make one: called as <launcher> run <kit script>
 * [arguments], it writes down its process id, its folder, what it was given and two
 * variables, and execs makersmcp's supervisor with the rest in place of itself. With
 * `supervises` false it becomes a process that never reads its stdin instead, like a
 * supervisor a kit stopped.
 */
function writeLauncher(dir, { supervises = true } = {}) {
  const file = path.join(dir, 'launch');
  const log = path.join(dir, 'launched');
  writeFileSync(file, [
    '#!/bin/sh',
    `{ echo "$$"; pwd -P; echo "\${ONLY_FOR_THE_KIT:-}"; echo "\${SECRET_OF_THE_SERVICE:-}"; printf '%s\\n' "$@"; } > ${sh(log)}`,
    '[ "$1" = run ] || { echo "launch: run <kit script> [arguments]" >&2; exit 2; }',
    'shift',
    supervises
      ? `exec ${sh(process.execPath)} ${sh(supervisor)} "$@"`
      : `exec ${sh(process.execPath)} -e 'setInterval(() => {}, 1000)'`,
  ].join('\n') + '\n', { mode: 0o755 });
  const launched = () => {
    const [pid, cwd, only, secret, ...words] = readFileSync(log, 'utf8').replace(/\n$/, '').split('\n');
    return { pid: Number(pid), cwd, only, secret, words };
  };
  return { launcher: [file, 'run'], log, launched };
}

/** A folder for one test, with a job's folder in it, cleaned up after. */
async function withFolder(callback) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'makersmcp-service-')));
  const baseDir = path.join(root, 'job');
  mkdirSync(baseDir);
  try {
    await callback({ root, baseDir });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Starts a fakekit tool on a LocalBackend made with `options`. */
function backendWith(options) {
  const backend = new LocalBackend({ kitPaths, ...options });
  const kits = backend.available(definitions).filter(isAvailable);
  const start = (name, input) => {
    const kit = kits.find(entry => entry.definition.tools.some(tool => tool.name === name));
    return backend.start({ kit, tool: kit.definition.tools.find(tool => tool.name === name), input });
  };
  return { backend, start };
}

/** Runs `callback` while no signal this process sends reaches another process, as when the kits are another user's. */
async function asAnotherUser(callback) {
  const { kill } = process;
  const childKill = ChildProcess.prototype.kill;
  const refused = () => Object.assign(new Error('kill EPERM'), { code: 'EPERM', errno: -1, syscall: 'kill' });
  process.kill = (pid, signal) => {
    if (signal === 0) return kill.call(process, pid, 0);
    throw refused();
  };
  // ChildProcess.kill reports a refused signal as an error event, not by throwing.
  ChildProcess.prototype.kill = function (signal) {
    if (signal === 0) return childKill.call(this, 0);
    this.emit('error', refused());
    return false;
  };
  try {
    return await callback();
  } finally {
    process.kill = kill;
    ChildProcess.prototype.kill = childKill;
  }
}

/** Stops what a test left running, once signals reach it again. */
function stop(pids) {
  for (const pid of pids) {
    if (!pid || !alive(pid)) continue;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Gone.
      }
    }
  }
}

test('a launcher starts each kit\'s supervisor in place of node, with the kit\'s script and arguments after its own words, in baseDir', { skip: notPosix }, async () => {
  await withFolder(async ({ root, baseDir }) => {
    const { launcher, launched } = writeLauncher(root);
    process.env.SECRET_OF_THE_SERVICE = 'only the service';
    try {
      const { backend, start } = backendWith({ baseDir, launcher, confine: true, env: { PATH: process.env.PATH, ONLY_FOR_THE_KIT: 'yes' } });
      const started = await start('fake_make', { url: 'https://example.com' });
      const view = await backend.wait(started.id, 20);
      assert.equal(view.status, 'done', view.failure);
      const folder = path.join(baseDir, 'fakekit-example.com');
      const call = launched();
      assert.deepEqual(call.words, ['run', fakeScript, 'https://example.com', '--out', folder, '--with', fakeScript]);
      assert.equal(call.cwd, baseDir);
      // The launcher gets the environment the backend was given, and what it passes on is its own affair.
      assert.equal(call.only, 'yes');
      assert.equal(call.secret, '');
      // It became the supervisor: the job's process is the launcher's.
      assert.equal(backend.jobs.get(started.id).pid, call.pid);
      // A job of its own folder, under confine, still returns its docs and files.
      assert.deepEqual(view.files.map(file => file.path), ['REPORT.md', path.join('parts', 'data.json')]);
      assert.deepEqual(view.docs.map(doc => doc.name), ['REPORT.md']);
      assert.match(view.docs[0].text, /Made from https:\/\/example\.com/);
    } finally {
      delete process.env.SECRET_OF_THE_SERVICE;
    }
  });
});

test('a launcher job\'s cancel closes its supervisor\'s stdin, which stops the kit and what it started, where no signal reaches them', { skip: notPosix }, async () => {
  await withFolder(async ({ root, baseDir }) => {
    const { launcher, launched } = writeLauncher(root);
    const { backend, start } = backendWith({ baseDir, launcher });
    const started = await start('fake_make', { url: 'https://tree.example.com' });
    const job = backend.jobs.get(started.id);
    const file = path.join(baseDir, 'fakekit-tree.example.com', 'pids.json');
    let pids = {};
    try {
      assert.ok(await until(() => existsSync(file)), 'the kit started its browser');
      pids = JSON.parse(readFileSync(file, 'utf8'));
      // The kit and its browser are in the supervisor's process group, the one a sweep keeps.
      assert.equal(job.pid, launched().pid);
      assert.equal(groupOf(pids.kit), job.pid);
      assert.equal(groupOf(pids.browser), job.pid);
      const canceled = await asAnotherUser(() => backend.cancel(started.id));
      assert.equal(canceled.status, 'canceled');
      assert.ok(await until(() => !alive(pids.kit) && !alive(pids.browser)), 'the kit and its browser are gone');
    } finally {
      stop([job?.pid, pids.kit, pids.browser]);
    }
  });
});

test('closing a launcher\'s backend closes every running supervisor\'s stdin', { skip: notPosix }, async () => {
  await withFolder(async ({ root, baseDir }) => {
    const { launcher } = writeLauncher(root);
    const { backend, start } = backendWith({ baseDir, launcher });
    const jobs = [];
    const pids = [];
    try {
      for (const url of ['https://tree.example.com', 'https://tree-two.example.com']) {
        const started = await start('fake_make', { url });
        jobs.push(backend.jobs.get(started.id));
        const file = path.join(baseDir, `fakekit-${new URL(url).hostname}`, 'pids.json');
        assert.ok(await until(() => existsSync(file)), url);
        pids.push(...Object.values(JSON.parse(readFileSync(file, 'utf8'))));
      }
      await asAnotherUser(async () => {
        backend.close();
        await Promise.all(jobs.map(job => job.finished));
      });
      assert.deepEqual(jobs.map(job => job.status), ['canceled', 'canceled']);
      assert.ok(await until(() => pids.every(pid => !alive(pid))), 'every kit and browser is gone');
    } finally {
      stop([...jobs.map(job => job.pid), ...pids]);
    }
  });
});

test('a launcher job that does not stop is given up on after killAfterMs, and left to the launcher to stop', { skip: notPosix }, async () => {
  await withFolder(async ({ root, baseDir }) => {
    const { launcher, log } = writeLauncher(root, { supervises: false });
    const { backend, start } = backendWith({ baseDir, launcher });
    const started = await start('fake_make', { url: 'https://example.com' });
    const job = backend.jobs.get(started.id);
    try {
      assert.ok(await until(() => existsSync(log)), 'the launcher ran');
      const before = Date.now();
      await asAnotherUser(() => job.cancel(300));
      assert.ok(Date.now() - before < 3000, 'the cancel did not wait for the kit');
      assert.equal(job.status, 'canceled');
      assert.match(job.stderr, /The kit had not stopped 0\.3 s after the cancel, so stopping it is left to its launcher\./);
      assert.ok(alive(job.pid), 'what the launcher started still runs, for its own clean-up');
    } finally {
      stop([job?.pid]);
    }
  });
});

test('a launcher that is not a command is refused before any kit runs', () => {
  for (const launcher of [[], [''], ['sudo', ''], 'sudo -n', [42], [null]]) {
    assert.throws(() => new LocalBackend({ baseDir: os.tmpdir(), launcher }), TypeError, JSON.stringify(launcher));
  }
  assert.doesNotThrow(() => new LocalBackend({ baseDir: os.tmpdir(), launcher: ['sudo', '-n', '-u', 'kits', '--', '/usr/local/lib/run-kit', 'run'] }));
});

test('a kit\'s doc is read only as a regular file with one name: a link, a hard link or a fifo is left out, and a fifo holds nothing up', { skip: notPosix }, async () => {
  await withFolder(async ({ root, baseDir }) => {
    const secret = path.join(root, 'secret.env');
    writeFileSync(secret, 'DB_PASSWORD=only-the-service\n');
    const folder = path.join(baseDir, 'out');
    mkdirSync(folder);
    writeFileSync(path.join(folder, 'REPORT.md'), '# Report\n');
    symlinkSync(secret, path.join(folder, 'LINKED.md'));
    linkSync(secret, path.join(folder, 'HARD.md'));
    assert.equal(spawnSync('mkfifo', [path.join(folder, 'FIFO.md')]).status, 0, 'mkfifo');
    const names = ['REPORT.md', 'LINKED.md', 'HARD.md', 'FIFO.md', 'MISSING.md'];
    // In a process of its own, so a doc that holds it cannot hold the tests.
    const script = `import { readDocs } from ${JSON.stringify(pathToFileURL(path.join(here, '..', 'dist', 'server.js')).href)};\n`
      + `process.stdout.write(JSON.stringify(readDocs(${JSON.stringify(folder)}, ${JSON.stringify(names)})));`;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(run.status, 0, run.error ? `readDocs did not return: ${run.error.message}` : run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), [{ name: 'REPORT.md', text: '# Report\n' }]);
  });
});

test('a long doc is still cut, with where the rest is', async () => {
  await withFolder(async ({ baseDir }) => {
    writeFileSync(path.join(baseDir, 'LONG.md'), 'é'.repeat(100_000));
    const [doc] = readDocs(baseDir, ['LONG.md']);
    assert.equal(doc.text, 'é'.repeat(40_000));
    assert.equal(doc.more, path.join(baseDir, 'LONG.md'));
  });
});

test('a file swapped for a link while its folder is listed is left out', { skip: notPosix }, async () => {
  await withFolder(async ({ root, baseDir }) => {
    const secret = path.join(root, 'secret.env');
    writeFileSync(secret, 'DB_PASSWORD=only-the-service\n');
    writeFileSync(path.join(baseDir, 'kept.txt'), 'x');
    writeFileSync(path.join(baseDir, 'swapped.txt'), 'x');
    const { readdirSync } = fs;
    // The swap comes right after the folder is read, as a kit still running could make it.
    fs.readdirSync = (folder, ...rest) => {
      const entries = readdirSync(folder, ...rest);
      if (path.resolve(String(folder)) === baseDir && !fs.lstatSync(path.join(baseDir, 'swapped.txt')).isSymbolicLink()) {
        rmSync(path.join(baseDir, 'swapped.txt'));
        symlinkSync(secret, path.join(baseDir, 'swapped.txt'));
      }
      return entries;
    };
    syncBuiltinESMExports();
    try {
      assert.deepEqual(listFiles(baseDir).map(file => file.path), ['kept.txt']);
    } finally {
      fs.readdirSync = readdirSync;
      syncBuiltinESMExports();
    }
  });
});

test('within a folder, as under confine, no doc or file comes from a folder that leads out of it, and no doc through a link', { skip: notPosix }, async () => {
  await withFolder(async ({ root, baseDir }) => {
    const write = (file, body = 'x') => {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), body);
    };
    write('elsewhere/REPORT.md', 'DB_PASSWORD=only-the-service\n');
    write('elsewhere/notes.txt');
    // The kit's own folder swapped for a link to a folder elsewhere.
    symlinkSync(path.join(root, 'elsewhere'), path.join(baseDir, 'out'));
    // A folder of the job's, and a link to it inside the job's folder.
    write('job/real/REPORT.md', '# Report\n');
    write('job/real/stills/STILLS.md', '# Stills\n');
    symlinkSync(path.join(baseDir, 'real'), path.join(baseDir, 'alias'));
    write('job/inner/REPORT.md', '# Inner\n');
    symlinkSync(path.join(root, 'elsewhere'), path.join(baseDir, 'inner', 'stills'));

    assert.deepEqual(listFiles(path.join(baseDir, 'out'), undefined, baseDir), []);
    assert.deepEqual(readDocs(path.join(baseDir, 'out'), ['REPORT.md'], baseDir), []);
    assert.deepEqual(readDocs(path.join(baseDir, 'alias'), ['REPORT.md'], baseDir), []);
    assert.deepEqual(readDocs(path.join(baseDir, 'inner'), ['REPORT.md', 'stills/REPORT.md'], baseDir).map(doc => doc.name), ['REPORT.md']);
    assert.deepEqual(listFiles(path.join(baseDir, 'real'), undefined, baseDir).map(file => file.path), ['REPORT.md', path.join('stills', 'STILLS.md')]);
    assert.deepEqual(readDocs(path.join(baseDir, 'real'), ['REPORT.md', 'stills/STILLS.md'], baseDir).map(doc => doc.text), ['# Report\n', '# Stills\n']);
    // Without a folder to keep to, as on the user's own machine, a folder of theirs through a link is theirs to read.
    assert.deepEqual(readDocs(path.join(baseDir, 'out'), ['REPORT.md']).map(doc => doc.name), ['REPORT.md']);
    assert.deepEqual(listFiles(path.join(baseDir, 'out')).map(file => file.path), ['notes.txt', 'REPORT.md']);
  });
});

test('a job a kit ran through a launcher, confined, returns no doc the kit left as a link to a file elsewhere', { skip: notPosix }, async () => {
  await withFolder(async ({ root, baseDir }) => {
    writeFileSync(path.join(root, 'secret.env'), 'DB_PASSWORD=only-the-service\n');
    const { launcher } = writeLauncher(root);
    for (const options of [{ confine: true, launcher }, {}]) {
      const server = createMcpServer({ definitions, backend: new LocalBackend({ baseDir, kitPaths, ...options }) });
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const result = await client.callTool({ name: 'fake_make', arguments: { url: 'https://links.example.com' } });
        assert.equal(result.structuredContent.status, 'done', text(result));
        assert.doesNotMatch(text(result), /DB_PASSWORD|### REPORT\.md/, JSON.stringify(options));
        assert.deepEqual(result.structuredContent.files, [], JSON.stringify(options));
      } finally {
        await client.close();
        await server.close();
        rmSync(path.join(baseDir, 'fakekit-links.example.com'), { recursive: true, force: true });
      }
    }
  });
});

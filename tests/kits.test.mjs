// The kit definitions in kits/ against the kits themselves, and launch-film's tools
// run with the copy installed here.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, loadKitDefinitions, resolveKit } from '../dist/server.js';

const kits = loadKitDefinitions();
const text = result => result.content.map(item => item.text).join('\n');
const hasFfmpeg = ['ffmpeg', 'ffprobe'].every(name => spawnSync(name, ['-version'], { stdio: 'ignore' }).status === 0);

test('every check tool says what its report is, so a kit error is not taken for a failed check', () => {
  for (const kit of kits) {
    for (const tool of kit.tools.filter(entry => entry.check)) assert.ok(tool.report, `${tool.name} has no report`);
  }
});

function tinyVideo(folder) {
  const file = path.join(folder, 'tiny.mp4');
  if (existsSync(file)) return;
  const made = spawnSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file,
  ]);
  assert.equal(made.status, 0, String(made.stderr));
}

async function withLaunchFilm(callback) {
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'makersmcp-kits-'));
  const server = createMcpServer({ kits: ['launch-film'], outDir });
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

const launchFilm = resolveKit(kits.find(kit => kit.kit === 'launch-film'));
const noLaunchFilm = launchFilm.script ? false : 'launch-film is not installed';

test('check_video on a file that is not a video is an error, not a failed check, and shows no old report', { skip: noLaunchFilm }, async () => {
  await withLaunchFilm(async (client, outDir) => {
    writeFileSync(path.join(outDir, 'notes.txt'), 'not a video');
    mkdirSync(path.join(outDir, 'check'));
    writeFileSync(path.join(outDir, 'check', 'CHECK.md'), '# film.mp4: PASS\n\nAn earlier run.\n');
    const result = await client.callTool({ name: 'check_video', arguments: { film: 'notes.txt' } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, 'failed');
    assert.equal(result.structuredContent.passed, undefined);
    assert.match(text(result), /could not be read as a video/);
    assert.match(text(result), /The check could not run: the kit wrote no CHECK\.md\./);
    assert.doesNotMatch(text(result), /An earlier run/);
  });
});

test('check_video on a real video is a check, passed or failed, with its CHECK.md', { skip: noLaunchFilm || (!hasFfmpeg && 'ffmpeg is not installed') }, async () => {
  await withLaunchFilm(async (client, outDir) => {
    tinyVideo(outDir);
    const result = await client.callTool({ name: 'check_video', arguments: { film: 'tiny.mp4', lufs: -14, wait_seconds: 60 } });
    assert.notEqual(result.isError, true, text(result));
    assert.equal(result.structuredContent.status, 'done');
    assert.equal(typeof result.structuredContent.passed, 'boolean');
    assert.match(text(result), /### CHECK\.md/);
    assert.ok(readFileSync(path.join(outDir, 'check', 'CHECK.md'), 'utf8').length > 0);
  });
});

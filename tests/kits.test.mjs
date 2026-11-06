// The kit definitions in kits/ against the kits themselves. The bounds of every number
// are tried with each installed kit's own parser, so a schema never offers a value the
// kit refuses. easybrandkit and launch-film are dependencies; the other kits run when
// MAKERSMCP_KIT_PATHS names their checkouts, the way the CLI takes it, like
// MAKERSMCP_KIT_PATHS=easyscreenshot=../easyscreenshot,musicfit=../musicfit npm test.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, loadKitDefinitions, resolveKit } from '../dist/server.js';

const kitPaths = Object.fromEntries((process.env.MAKERSMCP_KIT_PATHS ?? '').split(',').map(entry => entry.trim())
  .filter(entry => entry.includes('=')).map(entry => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]));
const kits = loadKitDefinitions();
const text = result => result.content.map(item => item.text).join('\n');
const hasFfmpeg = ['ffmpeg', 'ffprobe'].every(name => spawnSync(name, ['-version'], { stdio: 'ignore' }).status === 0);

test('every check tool says what its report is, so a kit error is not taken for a failed check', () => {
  for (const kit of kits) {
    for (const tool of kit.tools.filter(entry => entry.check)) assert.ok(tool.report, `${tool.name} has no report`);
  }
});

test('every number has its bounds', () => {
  for (const kit of kits) {
    for (const tool of kit.tools) {
      for (const [name, param] of Object.entries(tool.params)) {
        if (param.type === 'integer' || param.type === 'number') {
          assert.ok(param.min !== undefined && param.max !== undefined, `${tool.name}.${name} needs min and max`);
        }
      }
    }
  }
});

// How each kit reads its arguments and stops before it opens a browser or the network.
// `ran` tells from the run whether the kit took the arguments.
function dryRun(kit, tool, extra, folder) {
  const placeholder = name => {
    const param = tool.params[name];
    if (param.type === 'enum') return param.values[0];
    if (param.type === 'url' || param.type === 'url_or_path') return 'https://example.com';
    return path.join(folder, `no-${name}`);
  };
  const positional = tool.args.map(arg => /^\{(\w+)\}$/.test(arg) ? placeholder(arg.slice(1, -1)) : arg);
  switch (kit.kit) {
    case 'easybrandkit':
    case 'easyfontkit':
    case 'easyscreenshot':
      // These check every value before they look at --help.
      return { args: [...positional, ...extra, '--help'], ran: run => run.status === 0 };
    case 'musicfit':
      // It checks its numbers before it reads the track, and --analyze needs no length.
      // A track that is not there then ends it with 1; a refused value with 2.
      return { args: [...positional, '--analyze', ...extra], ran: run => run.status === 1 };
    case 'launch-film': {
      if (tool.name !== 'check_video') return { args: [...positional, ...extra, '--help'], ran: run => run.status === 0 };
      // A check reads its numbers once it has read the video, and writes CHECK.md once it has run.
      const out = mkdtempSync(path.join(folder, 'check-'));
      return {
        args: ['check', path.join(folder, 'tiny.mp4'), ...extra, '--out', out],
        ran: () => existsSync(path.join(out, 'CHECK.md')),
        needsVideo: true,
      };
    }
    default:
      return undefined;
  }
}

// One value each kit must refuse, to show its dry run tells a refusal at all.
const REFUSED = {
  easybrandkit: ['make_brand_kit', ['--timeout', '601']],
  easyfontkit: ['make_font_kit', ['--timeout', '29']],
  easyscreenshot: ['take_screenshots', ['--timeout', '901']],
  musicfit: ['fit_music', ['--lufs', '-4']],
  'launch-film': ['check_video', ['--lufs', '0']],
};

function tinyVideo(folder) {
  const file = path.join(folder, 'tiny.mp4');
  if (existsSync(file)) return;
  const made = spawnSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file,
  ]);
  assert.equal(made.status, 0, String(made.stderr));
}

for (const kit of kits) {
  const installed = resolveKit(kit, kitPaths);
  const skip = installed.script
    ? false
    : `${kit.kit} is not installed here (${installed.reason}); give its checkout in MAKERSMCP_KIT_PATHS`;

  test(`${kit.kit}: the kit takes every number at the bounds its tools offer`, { skip }, () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'makersmcp-kits-'));
    try {
      const run = (tool, extra) => {
        const dry = dryRun(kit, tool, extra, folder);
        assert.ok(dry, `${kit.kit} has no dry run in tests/kits.test.mjs: add one`);
        if (dry.needsVideo) {
          if (!hasFfmpeg) return undefined;
          tinyVideo(folder);
        }
        const result = spawnSync(process.execPath, [installed.script, ...dry.args], { cwd: folder, encoding: 'utf8', timeout: 60_000 });
        return { ran: dry.ran(result), result };
      };

      let tried = 0;
      for (const tool of kit.tools) {
        for (const [name, param] of Object.entries(tool.params)) {
          if (param.type !== 'integer' && param.type !== 'number') continue;
          for (const bound of [param.min, param.max].filter(value => value !== undefined)) {
            const outcome = run(tool, [param.flag, String(bound)]);
            if (!outcome) continue;
            tried++;
            assert.ok(outcome.ran, `${tool.name}.${name} ${bound}: the kit refused it:\n${outcome.result.stderr}${outcome.result.stdout}`);
          }
        }
      }
      const [refusedTool, refusedArgs] = REFUSED[kit.kit] ?? [];
      assert.ok(refusedTool, `${kit.kit} has no refused value in tests/kits.test.mjs: add one`);
      const refused = run(kit.tools.find(tool => tool.name === refusedTool), refusedArgs);
      if (refused) assert.equal(refused.ran, false, `${refusedTool} ${refusedArgs.join(' ')} should be refused, so the dry run can tell`);
      assert.ok(tried > 0 || !kit.tools.some(tool => Object.values(tool.params).some(param => param.min !== undefined)), 'nothing was tried');
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
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

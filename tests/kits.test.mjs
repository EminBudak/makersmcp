// The kit definitions in kits/ against the kits themselves. The bounds of every number
// are tried with each installed kit's own parser, so a schema never offers a value the
// kit refuses. easybrandkit and launch-film are dependencies; the other kits run when
// MAKERSMCP_KIT_PATHS names their checkouts, the way the CLI takes it, like
// MAKERSMCP_KIT_PATHS=easyscreenshot=../easyscreenshot,musicfit=../musicfit npm test.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildCommand, createMcpServer, loadKitDefinitions, resolveKit } from '../dist/server.js';

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

test('every number has its bounds, and every address an example with https://', () => {
  for (const kit of kits) {
    for (const tool of kit.tools) {
      for (const [name, param] of Object.entries(tool.params)) {
        if (param.type === 'integer' || param.type === 'number') {
          assert.ok(param.min !== undefined && param.max !== undefined, `${tool.name}.${name} needs min and max`);
        }
        if (param.type === 'url' || param.type === 'url_or_path') {
          assert.match(param.description, /https:\/\/\S+/, `${tool.name}.${name}`);
        }
      }
    }
  }
});

test('a tool that replaces folders in its own says it is destructive', () => {
  for (const kit of kits) {
    for (const tool of kit.tools) {
      if (tool.out?.replaces) assert.equal(tool.destructive, true, tool.name);
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

async function withLaunchFilm(callback, options = {}) {
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'makersmcp-kits-'));
  const server = createMcpServer({ kits: ['launch-film'], outDir, ...options });
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

test('plan_launch_film never deletes a brand folder of the user\'s, and the tools say they may replace one', { skip: noLaunchFilm }, async () => {
  await withLaunchFilm(async (client, outDir) => {
    const write = (file, body) => {
      mkdirSync(path.dirname(path.join(outDir, file)), { recursive: true });
      writeFileSync(path.join(outDir, file), body);
    };
    // A brand kit made elsewhere, the page's words so nothing is fetched, and the team's own brand/ folder.
    write('easybrandkit-acme.com/brand.json', JSON.stringify({
      version: 1, name: 'Acme', url: 'https://acme.com',
      colors: [{ hex: '#112233', role: 'primary' }, { hex: '#ffcc00', role: 'button' }],
    }));
    write('words.json', JSON.stringify({
      title: 'Acme widgets', description: 'Acme makes widgets for teams.',
      headings: [{ level: 1, text: 'Widgets for every team' }, { level: 2, text: 'Fast setup' }, { level: 2, text: 'Clear pricing' }],
      ctas: [], paragraphs: [], jsonld: [],
    }));
    write('project/brand/team-logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    write('project/brand/guidelines.md', '# Team guidelines\n');
    // A brand/ whose brand.json is the team's own design tokens, next to their logo.
    write('tokens/brand/brand.json', JSON.stringify({ color: { primary: { value: '#0055ff' } } }));
    write('tokens/brand/team-logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const plan = (out_dir, more = {}) => client.callTool({
      name: 'plan_launch_film',
      arguments: { url: 'https://acme.com', brand: 'easybrandkit-acme.com', words: 'words.json', out_dir, wait_seconds: 60, ...more },
    });
    const files = folder => readdirSync(path.join(outDir, folder)).sort();

    const refused = await plan('project');
    assert.equal(refused.isError, true);
    assert.match(text(refused), /not started[\s\S]*already holds other files[\s\S]*Give another out_dir/);
    assert.deepEqual(files('project/brand'), ['guidelines.md', 'team-logo.svg']);

    for (const more of [{}, { url: 'https://apps.apple.com/us/app/acme/id1234567890', brand: undefined }]) {
      const tokens = await plan('tokens', more);
      assert.equal(tokens.isError, true, JSON.stringify(more));
      assert.match(text(tokens), /not started[\s\S]*brand\.json is not one a kit made \(no "version": 1 in it\)/);
      assert.deepEqual(files('tokens/brand'), ['brand.json', 'team-logo.svg']);
      assert.match(readFileSync(path.join(outDir, 'tokens', 'brand', 'brand.json'), 'utf8'), /#0055ff/);
    }

    const fresh = await plan('fresh');
    assert.equal(fresh.structuredContent.status, 'done', text(fresh));
    assert.ok(existsSync(path.join(outDir, 'fresh', 'film.json')));
    assert.deepEqual(fresh.structuredContent.files.map(file => file.path).sort(), [path.join('brand', 'brand.json'), 'film.json', 'words.json']);

    // A brand/ an earlier run made is the kit's to replace, until a file is added to it by hand.
    const again = await plan('fresh');
    assert.equal(again.structuredContent.status, 'done', text(again));
    write('fresh/brand/our-notes.md', '# Our notes\n');
    const noted = await plan('fresh');
    assert.equal(noted.isError, true);
    assert.match(text(noted), /not started[\s\S]*brand holds our-notes\.md, which its brand\.json does not list/);
    assert.deepEqual(files('fresh/brand'), ['brand.json', 'our-notes.md']);

    const { tools } = await client.listTools();
    for (const name of ['make_launch_film', 'plan_launch_film', 'make_launch_stills']) {
      const entry = tools.find(item => item.name === name);
      assert.equal(entry.annotations.destructiveHint, true, name);
      const when = name === 'make_launch_stills' ? 'for an App Store page' : 'when given brand, or for an App Store page';
      assert.ok(entry.inputSchema.properties.out_dir.description.includes(
        ` The kit deletes the brand/ folder in it and makes it again ${when}, so it does not start then while that folder holds a file that would be lost.`,
      ), name);
    }
    assert.match(tools.find(item => item.name === 'plan_launch_film').inputSchema.properties.out_dir.description, / To use that brand\/ folder where it is, give brand as out_dir with \/brand added, written the same way\.$/);
    assert.equal(tools.find(item => item.name === 'check_video').annotations.destructiveHint, false);
  });
});

// A brand kit and the page's words, so a plan reads nothing from the network.
const ACME_KIT = { version: 1, name: 'Acme', url: 'https://acme.com', colors: [{ hex: '#112233', role: 'primary' }, { hex: '#ffcc00', role: 'button' }] };
const ACME_WORDS = {
  title: 'Acme widgets', description: 'Acme makes widgets for teams.',
  headings: [{ level: 1, text: 'Widgets for every team' }, { level: 2, text: 'Fast setup' }, { level: 2, text: 'Clear pricing' }],
  ctas: [], paragraphs: [], jsonld: [],
};
const fakeEasybrandkit = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-easybrandkit');

test('plan_launch_film plans again from the kit folder it copied, with the files that folder holds', { skip: noLaunchFilm }, async () => {
  await withLaunchFilm(async (client, outDir) => {
    const write = (file, body) => {
      mkdirSync(path.dirname(path.join(outDir, file)), { recursive: true });
      writeFileSync(path.join(outDir, file), body);
    };
    // A kit kept with a note, a .gitkeep and its fonts: launch-film copies all of it into brand/.
    write('kit-with-note/brand.json', JSON.stringify(ACME_KIT));
    write('kit-with-note/notes.md', '# Kept with the kit\n');
    write('kit-with-note/.gitkeep', '');
    write('kit-with-note/fonts/brand.woff2', 'font');
    write('other-kit/brand.json', JSON.stringify({ ...ACME_KIT, name: 'Other' }));
    write('words.json', JSON.stringify(ACME_WORDS));
    const plan = brand => client.callTool({
      name: 'plan_launch_film',
      arguments: { url: 'https://acme.com', brand, words: 'words.json', out_dir: 'film', wait_seconds: 60 },
    });
    const files = folder => readdirSync(path.join(outDir, folder), { recursive: true }).map(String).sort();
    const kept = ['.gitkeep', 'brand.json', 'fonts', path.join('fonts', 'brand.woff2'), 'notes.md'];

    for (const round of [1, 2]) {
      const result = await plan('kit-with-note');
      assert.equal(result.structuredContent?.status, 'done', `round ${round}: ${text(result)}`);
      assert.deepEqual(files('film/brand'), kept);
    }
    // Another kit would not bring the note back.
    const other = await plan('other-kit');
    assert.equal(other.isError, true);
    assert.match(text(other), /not started[\s\S]*film\/brand holds \.gitkeep, fonts\/ and notes\.md, which its brand\.json does not list and the copy would not bring back/);
    assert.deepEqual(files('film/brand'), kept);
    assert.deepEqual(files('kit-with-note'), kept);
  });
});

test('plan_launch_film from a website has easybrandkit make brand/ again where it is, keeping a file of the user\'s', { skip: noLaunchFilm }, async () => {
  await withLaunchFilm(async (client, outDir) => {
    const write = (file, body) => {
      mkdirSync(path.dirname(path.join(outDir, file)), { recursive: true });
      writeFileSync(path.join(outDir, file), body);
    };
    write('words.json', JSON.stringify(ACME_WORDS));
    write('project/brand/team-logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const plan = out_dir => client.callTool({
      name: 'plan_launch_film',
      arguments: { url: 'https://acme.com', words: 'words.json', out_dir, wait_seconds: 60 },
    });
    const files = folder => readdirSync(path.join(outDir, folder)).sort();

    const first = await plan('site');
    assert.equal(first.structuredContent?.status, 'done', text(first));
    assert.deepEqual(files('site/brand'), ['BRAND.md', 'brand.json']);
    // A note added to that kit stays: easybrandkit replaces only the kit's own files.
    write('site/brand/our-notes.md', '# Our notes\n');
    const again = await plan('site');
    assert.equal(again.structuredContent?.status, 'done', text(again));
    assert.deepEqual(files('site/brand'), ['BRAND.md', 'brand.json', 'our-notes.md']);
    assert.equal(readFileSync(path.join(outDir, 'site', 'brand', 'our-notes.md'), 'utf8'), '# Our notes\n');

    // A file named like the kit's own logos would be replaced, so the tool does not start.
    write('site/brand/logo-03.png', 'ours');
    const named = await plan('site');
    assert.equal(named.isError, true);
    assert.match(text(named), /not started[\s\S]*makes the brand folder in .*site again[\s\S]*holds logo-03\.png, which its brand\.json does not list/);
    assert.equal(readFileSync(path.join(outDir, 'site', 'brand', 'logo-03.png'), 'utf8'), 'ours');

    // A brand/ that holds no kit: easybrandkit does not start in it, and nothing goes.
    const project = await plan('project');
    assert.equal(project.isError, true);
    assert.equal(project.structuredContent?.status, 'failed');
    assert.match(text(project), /is not empty and holds no earlier brand kit/);
    assert.deepEqual(files('project/brand'), ['team-logo.svg']);
  }, { kitPaths: { easybrandkit: fakeEasybrandkit } });
});

test('plan_launch_film refuses a kit that is the brand/ folder by another path, or a folder around it, and loses nothing', { skip: noLaunchFilm }, async () => {
  await withLaunchFilm(async (client, outDir) => {
    const write = (file, body) => {
      mkdirSync(path.dirname(path.join(outDir, file)), { recursive: true });
      writeFileSync(path.join(outDir, file), body);
    };
    write('words.json', JSON.stringify(ACME_WORDS));
    // The team's kit with their notes and logo, and a second path to it through a link to the folder above.
    write('marketing/brand/brand.json', JSON.stringify(ACME_KIT));
    write('marketing/brand/notes.md', '# The team notes\n');
    write('marketing/brand/team-logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    symlinkSync(path.join(outDir, 'marketing'), path.join(outDir, 'alias'));
    // A kit folder that holds a film's folder, with the brand/ copied from it before.
    write('big/brand.json', JSON.stringify(ACME_KIT));
    write('big/film/brand/brand.json', JSON.stringify(ACME_KIT));
    const plan = (brand, out_dir) => client.callTool({
      name: 'plan_launch_film',
      arguments: { url: 'https://acme.com', brand, words: 'words.json', out_dir, wait_seconds: 60 },
    });
    const files = folder => readdirSync(path.join(outDir, folder)).sort();
    const team = ['brand.json', 'notes.md', 'team-logo.svg'];

    for (const [brand, out_dir] of [['alias/brand', 'marketing'], ['marketing/brand', 'alias']]) {
      const aliased = await plan(brand, out_dir);
      assert.equal(aliased.isError, true, brand);
      assert.match(text(aliased), /not started[\s\S]*is that same folder under another name, so it would be gone before the copy\. Give brand as .*\/brand to use it where it is\./);
      assert.deepEqual(files('marketing/brand'), team);
    }
    // As the refusal says, the kit then uses the folder where it is.
    const inPlace = await plan('marketing/brand', 'marketing');
    assert.equal(inPlace.structuredContent?.status, 'done', text(inPlace));
    assert.deepEqual(files('marketing/brand'), team);

    const around = await plan('big', 'big/film');
    assert.equal(around.isError, true);
    assert.match(text(around), /not started[\s\S]*film\/brand is inside .*big, and a folder cannot be copied into itself\. Give an out_dir outside/);
    assert.deepEqual(files('big/film/brand'), ['brand.json']);
  });
});

// Whether a folder is on a disk that ignores letter case, as macOS and Windows have by default.
function ignoresCase(folder) {
  writeFileSync(path.join(folder, 'case.txt'), '');
  try {
    return existsSync(path.join(folder, 'CASE.TXT'));
  } finally {
    rmSync(path.join(folder, 'case.txt'), { force: true });
  }
}

test('on a real disk that ignores letter case, and through a bind mount, a kit given as brand/ by another path loses nothing', { skip: noLaunchFilm }, t => {
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'alias-disk.mjs');
  const folder = mkdtempSync(path.join(os.tmpdir(), 'makersmcp-alias-'));
  try {
    let run;
    if (ignoresCase(folder)) {
      run = spawnSync(process.execPath, [fixture, folder], { encoding: 'utf8', timeout: 120_000 });
    } else if (process.platform === 'linux') {
      // Linux makes both where only this test sees them: a tmpfs that folds letter case, in a
      // user and mount namespace of the test's own, where it may mount.
      const script = 'mount -t tmpfs -o casefold,size=16m makersmcp "$1" && mkdir "$1/ci" && chattr +F "$1/ci" || exit 77\nexec "$2" "$3" "$1/ci" --bind';
      run = spawnSync('unshare', ['--user', '--map-root-user', '--mount', 'sh', '-c', script, 'sh', folder, process.execPath, fixture], { encoding: 'utf8', timeout: 120_000 });
      if (run.error || run.status === 77 || /^unshare:/m.test(run.stderr)) {
        t.skip(`no such disk can be made here: ${(run.error?.message ?? run.stderr).trim().split('\n').pop()}`);
        return;
      }
    } else {
      t.skip('the temporary folder minds letter case, and no disk that ignores it can be made here');
      return;
    }
    assert.equal(run.status, 0, run.stderr);
    const calls = run.stdout.trim().split('\n').map(line => JSON.parse(line));
    const refused = {
      'kit given in other letters': /is that same folder under another name/,
      'kit with only its own files, as its brand.json in other letters': /is that same folder under another name/,
      'kit given through a bind mount': /is that same folder under another name/,
      'out_dir through a bind mount': /is that same folder under another name/,
    };
    for (const call of calls) {
      if (call.name === 'kit given the way out_dir is') {
        assert.equal(call.status, 'done', call.said);
      } else {
        assert.equal(call.status, 'not started', `${call.name}: ${call.said}`);
        assert.match(call.said, refused[call.name], call.name);
      }
      assert.ok(call.kept, `${call.name}: a file went or changed. ${call.said}`);
    }
    assert.ok(calls.length >= 4, run.stdout);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('make_launch_stills takes for a film.json what launch-film takes for one, and the rest for an address', { skip: noLaunchFilm }, () => {
  const stills = kits.find(kit => kit.kit === 'launch-film').tools.find(tool => tool.name === 'make_launch_stills');
  const asFile = new RegExp(`^(?:${stills.params.source.filePattern})$`);
  const folder = mkdtempSync(path.join(os.tmpdir(), 'makersmcp-kits-'));
  try {
    // Values none of which reach the network: the kit fails on each, saying how it took it.
    const values = [
      'https://example.com/film.json', 'https://example.com/plans/FILM.JSON', 'http://example.com/a.Json',
      path.join(folder, 'missing.json'), path.join(folder, 'Missing.JSON'),
      path.join(folder, 'film.txt'), path.join(folder, 'film.json.bak'), path.join(folder, 'film.jsonx'),
    ];
    for (const value of values) {
      const run = spawnSync(process.execPath, [launchFilm.script, 'stills', value], { cwd: folder, encoding: 'utf8', timeout: 30_000 });
      const tookFile = /is not a file/.test(run.stderr);
      assert.ok(tookFile || /is not an address or a film\.json/.test(run.stderr), `${value}: ${run.stderr}`);
      assert.equal(asFile.test(value), tookFile, value);
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('what launch-film\'s tools take for a brand kit\'s own files, easybrandkit replaces as its own too', () => {
  const require = createRequire(import.meta.url);
  const { prepareDir } = require('easybrandkit');
  // The names easybrandkit deletes after a run that failed, whether its kit listed them or not.
  const cleanUp = /^const RUN_FILE = \/(.+)\/;$/m.exec(readFileSync(require.resolve('easybrandkit'), 'utf8'));
  assert.ok(cleanUp, 'easybrandkit has no RUN_FILE any more: see which files it deletes after a failed run');
  const runFile = new RegExp(cleanUp[1]);
  const tools = kits.find(kit => kit.kit === 'launch-film').tools.filter(tool => tool.out?.replaces?.brand);
  assert.deepEqual(tools.map(tool => tool.name), ['make_launch_film', 'plan_launch_film', 'make_launch_stills']);
  // A kit as easybrandkit writes one: a file at each place its brand.json lists them.
  const marker = {
    version: 1,
    logos: [{ file: 'logo-01.png', svg: 'logo-01.svg' }],
    screenshots: [{ file: 'screen-01.png' }],
    card: { file: 'card.png' },
    stores: [{ type: 'appstore', assets: [{ file: 'appstore-icon.png' }, { file: 'appstore-shot-01.jpg' }] }],
  };
  const listed = ['logo-01.png', 'logo-01.svg', 'screen-01.png', 'card.png', 'appstore-icon.png', 'appstore-shot-01.jpg'];
  const names = [
    ...listed, 'logo-1.png', 'logo-123.png', 'logo-02.svg', 'screen-02.png', 'googleplay-shot-12.webp', 'x-profile.jpg',
    'youtube-icon.png', 'linkedin-profile.webp', 'threads-shot-3.png', 'pinterest-icon.jpg',
    'logo.png', 'logo-01.jpg', 'screen-01.svg', 'card.jpg', 'appstore-icon.gif', 'tiktok-icon.png', 'team-logo.svg', 'our-notes.md',
  ];
  for (const tool of tools) {
    const kind = tool.out.replaces.brand;
    const named = new RegExp(`^(?:${kind.names})$`);
    for (const name of names) assert.equal(named.test(name), runFile.test(name), `${tool.name}: ${name}`);

    const baseDir = mkdtempSync(path.join(os.tmpdir(), 'makersmcp-kit-'));
    try {
      const brand = path.join(baseDir, 'film', 'brand');
      for (const file of ['brand.json', ...kind.files, ...listed]) {
        mkdirSync(path.dirname(path.join(brand, file)), { recursive: true });
        writeFileSync(path.join(brand, file), file === 'brand.json' ? JSON.stringify(marker) : 'x');
      }
      const call = address => () => buildCommand(tool, { url: address, source: address, out_dir: 'film' }, { baseDir, installed: new Map() });
      const store = 'https://apps.apple.com/us/app/acme/id1234567890';
      assert.ok(call(store)().args.includes('--out'), tool.name);
      writeFileSync(path.join(brand, 'our-notes.md'), '# Our notes\n');
      // For an App Store page, launch-film may delete all of brand/.
      assert.throws(call(store), /film\/brand holds our-notes\.md, which its brand\.json does not list/, tool.name);
      // For a website, easybrandkit makes the kit again in it and keeps the note.
      assert.ok(call('https://acme.com')().args.includes('--out'), tool.name);
      // easybrandkit, making a kit again in that folder, deletes every one of the kit's files and keeps the note.
      prepareDir(brand);
      assert.deepEqual(readdirSync(brand), ['our-notes.md'], tool.name);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  }
});

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

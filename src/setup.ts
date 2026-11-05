import { accessSync, constants, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isInstalled, type InstalledKit, type MissingKit } from './kits.js';

const CHROME_NAMES = [
  'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
  'microsoft-edge', 'microsoft-edge-stable', 'brave-browser', 'chrome',
];

const CHROME_PLACES = process.platform === 'darwin'
  ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ]
  : process.platform === 'win32'
    ? [
      [process.env['PROGRAMFILES'], 'Google/Chrome/Application/chrome.exe'],
      [process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'],
      [process.env['LOCALAPPDATA'], 'Google/Chrome/Application/chrome.exe'],
      [process.env['PROGRAMFILES(X86)'], 'Microsoft/Edge/Application/msedge.exe'],
      [process.env['PROGRAMFILES'], 'BraveSoftware/Brave-Browser/Application/brave.exe'],
    ].filter(([base]) => base).map(([base, rest]) => path.join(base!, rest!))
    : [];

const NEED_NAMES: Record<string, string> = { chrome: 'Chrome', ffmpeg: 'ffmpeg' };

function onPath(name: string): string | undefined {
  const names = process.platform === 'win32' ? [`${name}.exe`, name] : [name];
  for (const dir of (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean)) {
    for (const candidate of names) {
      const full = path.join(dir, candidate);
      if (existsSync(full)) return full;
    }
  }
  return undefined;
}

function fromEnv(...names: string[]): string | undefined {
  return names.map(name => process.env[name]).find((value): value is string => Boolean(value && existsSync(value)));
}

/** A browser the kits can use, looked for the way they look. */
export function findChrome(): string | undefined {
  return fromEnv('CHROME_PATH', 'LAUNCH_FILM_CHROME')
    ?? CHROME_NAMES.map(onPath).find(Boolean)
    ?? CHROME_PLACES.find(place => existsSync(place));
}

export function findFfmpeg(): string | undefined {
  return fromEnv('FFMPEG_PATH', 'LAUNCH_FILM_FFMPEG') ?? onPath('ffmpeg');
}

/**
 * Where the kits save: MAKERSMCP_OUT, else the folder makersmcp was started in
 * (an agent's project), else ~/makersmcp when that folder is / or read-only.
 */
export function defaultOutDir(): string {
  const given = process.env['MAKERSMCP_OUT'];
  if (given) return path.resolve(given);
  const cwd = process.cwd();
  try {
    if (path.parse(cwd).root !== cwd) {
      accessSync(cwd, constants.W_OK);
      return cwd;
    }
  } catch {
    // Not writable: fall through.
  }
  return path.join(os.homedir(), 'makersmcp');
}

/** The setup in words: kits, their state, the browser, ffmpeg and the folder. */
export function setupReport(options: {
  version: string;
  baseDir: string;
  kits: Array<InstalledKit | MissingKit>;
  enabled: Set<string>;
}): string {
  const chrome = findChrome();
  const ffmpeg = findFfmpeg();
  const lines = [
    `## makersmcp ${options.version}`,
    '',
    `Node ${process.versions.node}. Files go to ${options.baseDir} (set it with --out or MAKERSMCP_OUT).`,
    '',
    'Kits:',
  ];
  for (const kit of options.kits) {
    const { definition } = kit;
    const tools = definition.tools.map(tool => tool.name).join(', ');
    const needs = definition.needs.length
      ? ` Needs ${definition.needs.map(need => NEED_NAMES[need] ?? need).join(' and ')}.`
      : '';
    let state: string;
    if (!isInstalled(kit)) state = `not available: ${kit.reason}.`;
    else if (!options.enabled.has(definition.kit)) state = `${kit.version}, turned off by --kits.`;
    else state = `${kit.version}, on. Tools: ${tools}.${needs}`;
    lines.push(`- ${definition.kit} (${definition.field}): ${state}`);
  }
  lines.push(
    '',
    `Chrome: ${chrome ?? 'not found in the usual places. Install Chrome, Chromium, Edge or Brave, or set CHROME_PATH.'}`,
    `ffmpeg: ${ffmpeg ?? 'not found on PATH. Install ffmpeg or set FFMPEG_PATH.'}`,
  );
  return lines.join('\n');
}

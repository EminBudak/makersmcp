import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InstalledKit, ParamDefinition, ReplacedFolder, ToolDefinition } from './kits.js';

// Files a system leaves in any folder a person opens, which nobody misses.
const SYSTEM_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/** A tool call that cannot become a command, like a file that is not there. */
export class ArgumentError extends Error {}

export interface BuiltCommand {
  args: string[];
  /** Where the kit writes, when it is known. */
  folder?: string;
}

export interface CommandContext {
  /** What relative paths are read from, and where the folders go. */
  baseDir: string;
  /** The kits that are installed, for `uses`. */
  installed: Map<string, InstalledKit>;
  /** Refuse every file and folder outside baseDir, for a service that brings a job's inputs into it. */
  confine?: boolean;
}

export function isUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value);
}

/**
 * A path with a leading ~ for the home folder, the way a shell reads it. Settings and
 * tool arguments reach makersmcp without a shell, so nothing else expands it.
 */
export function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || (process.platform === 'win32' && value.startsWith('~\\'))) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

/** The text a text_or_path parameter takes as it is; any other value is a file. */
export function textPattern(param: ParamDefinition): RegExp {
  return new RegExp(`^(?:${param.pattern ?? '(?!)'})$`);
}

/** The host part of a folder name, the way the kits name theirs: launch-film-linear.app. */
export function hostOf(value: string): string | undefined {
  if (!isUrl(value)) return undefined;
  try {
    return new URL(value).hostname.replace(/^www\./, '').replace(/[^a-z0-9.-]/gi, '-');
  } catch {
    return undefined;
  }
}

/** A path with its links resolved, as far up as it exists, so a link cannot lead out of a folder. */
function realPath(file: string): string {
  let head = file;
  const rest: string[] = [];
  while (!existsSync(head)) {
    const parent = path.dirname(head);
    if (parent === head) break;
    rest.unshift(path.basename(head));
    head = parent;
  }
  try {
    return path.join(realpathSync(head), ...rest);
  } catch {
    return file;
  }
}

function isInside(folder: string, file: string): boolean {
  const relative = path.relative(realPath(folder), realPath(file));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * Turns a tool call into the kit's arguments: the positional ones from `args`,
 * then a flag for each parameter given, then the folder and the other kits the
 * tool uses. Relative paths are read from baseDir, where the folders go too.
 */
export function buildCommand(
  tool: ToolDefinition,
  input: Record<string, unknown>,
  context: CommandContext,
): BuiltCommand {
  const { baseDir } = context;
  const resolve = (name: string, value: string): string => {
    const full = path.resolve(baseDir, expandHome(value));
    if (context.confine && !isInside(baseDir, full)) {
      throw new ArgumentError(`${name}: ${value} is outside ${baseDir}, the only folder this server reads from`);
    }
    return full;
  };

  const values: Record<string, unknown> = {};
  // The files and folders the call names, as the kit gets them.
  const files: string[] = [];
  for (const [name, param] of Object.entries(tool.params)) {
    let value = input[name];
    if (value === undefined || value === null || value === '') continue;
    if (param.type === 'path' || param.type === 'url_or_path' || param.type === 'text_or_path') {
      const text = String(value);
      const kept = (param.type === 'url_or_path' && isUrl(text))
        || (param.type === 'text_or_path' && textPattern(param).test(text));
      if (!kept) {
        if (param.type === 'text_or_path' && isUrl(text)) {
          throw new ArgumentError(`${name}: the kit cannot read a link. Give the text itself, or a file. ${param.description}`);
        }
        value = resolve(name, text);
        if (!existsSync(value as string)) throw new ArgumentError(nothingAt(name, param, value as string, text));
        files.push(value as string);
      }
    }
    values[name] = value;
  }

  const args = tool.args.map(arg => {
    const match = /^\{(\w+)\}$/.exec(arg);
    return match ? String(values[match[1]]) : arg;
  });

  for (const [name, param] of Object.entries(tool.params)) {
    const value = values[name];
    if (!param.flag || value === undefined) continue;
    if (param.type === 'boolean') {
      if (value === (param.when ?? true)) args.push(param.flag);
    } else if (param.type === 'list') {
      const items = value as string[];
      if (items.length) args.push(param.flag, items.join(','));
    } else if (param.type === 'repeat') {
      for (const item of value as string[]) args.push(param.flag, String(item));
    } else {
      args.push(param.flag, String(value));
    }
  }

  let folder: string | undefined;
  if (tool.out) {
    const given = typeof input.out_dir === 'string' && input.out_dir ? input.out_dir : undefined;
    const named = fill(tool.out.name, tool, values);
    const other = named === undefined && tool.out.otherwise !== undefined
      ? fill(tool.out.otherwise, tool, values)
      : undefined;
    if (other !== undefined) {
      // The kit picks this folder itself and takes no flag for it.
      folder = path.resolve(baseDir, other);
      if (given !== undefined && resolve('out_dir', given) !== folder) {
        throw new ArgumentError(`out_dir: with these arguments ${tool.name} saves in ${folder} and cannot save anywhere else. Leave out_dir out.`);
      }
    } else if (given !== undefined || named !== undefined) {
      folder = given !== undefined ? resolve('out_dir', given) : path.resolve(baseDir, named!);
      if (tool.out.flag) {
        refuseReplacing(tool, folder, values, files);
        args.push(tool.out.flag, folder);
      }
    }
  }

  for (const [flag, kit] of Object.entries(tool.uses ?? {})) {
    const other = context.installed.get(kit);
    if (other) args.push(flag, other.script);
  }

  return { args, folder };
}

function nothingAt(name: string, param: ParamDefinition, full: string, text: string): string {
  if (param.type === 'url_or_path') {
    return `${name}: there is nothing at ${full}. A website's address starts with https://, like https://linear.app.`;
  }
  if (param.type === 'text_or_path') {
    return `${name}: there is nothing at ${full}, and "${text}" is not text the kit takes. ${param.description}`;
  }
  return `${name}: there is nothing at ${full}`;
}

/**
 * Refuses a call that would have the kit delete a folder in `folder` that it replaces
 * with its own (out.replaces) while that folder holds anything a kit did not put there,
 * or a file the call names. The kit deletes the whole folder, so a file a person added
 * to a kit's folder goes too. A folder the call gives in `from` is used where it is.
 */
function refuseReplacing(tool: ToolDefinition, folder: string, values: Record<string, unknown>, files: string[]): void {
  for (const [name, kind] of Object.entries(tool.out?.replaces ?? {})) {
    const dir = path.join(folder, name);
    if (kind.from !== undefined && usedInPlace(values[kind.from], dir)) continue;
    const inside = files.find(file => isInside(dir, file));
    const why = inside ? `${inside} is inside it` : notAKitsOwn(dir, kind);
    if (why) {
      throw new ArgumentError(
        `${tool.name} replaces the ${name} folder in ${folder} with its own, deleting what is there, and ${why}. `
        + 'Give another out_dir, or move those files first.',
      );
    }
  }
}

/**
 * Whether a folder the call gives, or a file in it, is `dir` itself. The kit then uses
 * the folder where it is, the way it compares them: by path, links unresolved.
 */
function usedInPlace(value: unknown, dir: string): boolean {
  if (typeof value !== 'string') return false;
  try {
    return (statSync(value).isDirectory() ? value : path.dirname(value)) === dir;
  } catch {
    return false;
  }
}

/**
 * What in a folder the kit would delete is not a kit's own, in words. Nothing when the
 * folder is not there, is empty, or holds only its marker, its files and what the
 * marker lists.
 */
function notAKitsOwn(dir: string, kind: ReplacedFolder): string | undefined {
  try {
    if (!statSync(dir).isDirectory()) return `${dir} is a file, not a folder`;
    if (readdirSync(dir).every(entry => SYSTEM_FILES.has(entry))) return undefined;
  } catch (error) {
    // Not there, or a link to nothing: there is nothing to lose.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return `${dir} cannot be read`;
  }

  const markerFile = path.join(dir, kind.marker);
  if (!existsSync(markerFile)) return `${dir} already holds other files (no ${kind.marker} in it)`;
  let marker: unknown;
  if (kind.version !== undefined || kind.lists?.length) {
    try {
      marker = JSON.parse(readFileSync(markerFile, 'utf8'));
    } catch {
      return `${markerFile} is not one a kit made`;
    }
    if (kind.version !== undefined && (marker as { version?: unknown } | null)?.version !== kind.version) {
      return `${markerFile} is not one a kit made (no "version": ${kind.version} in it)`;
    }
  }

  const own = new Set([kind.marker, ...(kind.files ?? []), ...(kind.lists ?? []).flatMap(where => listedIn(marker, where))]);
  let others: string[];
  try {
    others = notOwn(dir, own);
  } catch {
    return `${dir} cannot be read`;
  }
  if (!others.length) return undefined;
  return `${dir} holds ${namesInWords(others)}, which ${kind.lists?.length ? `its ${kind.marker} does not list` : 'no kit made'}`;
}

/**
 * The names a marker lists at a place like logos.file, the file of each of its logos.
 * By name only, as the kits read them, so a marker cannot name a file elsewhere.
 */
function listedIn(marker: unknown, where: string): string[] {
  const flat = (values: unknown[]) => values.flatMap(value => (Array.isArray(value) ? value : [value]));
  let found: unknown[] = [marker];
  for (const key of where.split('.')) {
    found = flat(found).map(value => (value !== null && typeof value === 'object' && Object.hasOwn(value, key)
      ? (value as Record<string, unknown>)[key]
      : undefined));
  }
  return flat(found)
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.split(/[\\/]/).pop() ?? '')
    .filter(Boolean);
}

/**
 * The entries of a folder that are not among its own files, like notes.md or drafts/,
 * in name order. Links are entries like files: deleting one leaves what it points to.
 */
function notOwn(dir: string, own: Set<string>): string[] {
  const found: string[] = [];
  const walk = (relative: string) => {
    const entries = readdirSync(path.join(dir, relative), { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (SYSTEM_FILES.has(entry.name)) continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if ([...own].some(file => file.startsWith(`${name}/`))) walk(name);
        else found.push(`${name}/`);
      } else if (!own.has(name)) {
        found.push(name);
      }
    }
  };
  walk('');
  return found;
}

/** A few names in words: a, a and b, or a, b, c and 2 more. */
function namesInWords(names: string[]): string {
  if (names.length > 4) return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]!;
}

/** Fills {host}, {dir:param}, {stem:param} and {param}, or gives undefined. */
function fill(template: string, tool: ToolDefinition, values: Record<string, unknown>): string | undefined {
  let ok = true;
  const filled = template.replace(/\{(?:(dir|stem):)?(\w+)\}/g, (_, fn: string | undefined, name: string) => {
    if (!fn && name === 'host') {
      const host = Object.entries(tool.params)
        .filter(([, param]) => param.type === 'url' || param.type === 'url_or_path')
        .map(([key]) => values[key])
        .filter((value): value is string => typeof value === 'string')
        .map(hostOf)
        .find(Boolean);
      if (!host) ok = false;
      return host ?? '';
    }
    const value = values[name];
    if (typeof value !== 'string' || (fn && isUrl(value))) {
      ok = false;
      return '';
    }
    if (fn === 'dir') return path.dirname(value);
    if (fn === 'stem') return path.basename(value, path.extname(value));
    return value;
  });
  return ok ? filled : undefined;
}

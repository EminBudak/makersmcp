import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
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

/** A regular expression from a kit's definition, matched in full. */
function inFull(source: string | undefined): RegExp {
  return new RegExp(`^(?:${source ?? '(?!)'})$`);
}

/** The text a text_or_path parameter takes as it is; any other value is a file. */
export function textPattern(param: ParamDefinition): RegExp {
  return inFull(param.pattern);
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
      // A kit that tells a file by the value itself, like one that ends in .json, takes what it
      // matches for a file, a link too, and anything else for an address.
      const asFile = param.type === 'url_or_path' && param.filePattern !== undefined ? inFull(param.filePattern) : undefined;
      if (kept && asFile?.test(text)) {
        throw new ArgumentError(`${name}: the kit takes ${text} for a file, not for an address, and cannot download one. ${param.description}`);
      }
      if (!kept) {
        if (param.type === 'text_or_path' && isUrl(text)) {
          throw new ArgumentError(`${name}: the kit cannot read a link. Give the text itself, or a file. ${param.description}`);
        }
        value = resolve(name, text);
        if (!existsSync(value as string)) throw new ArgumentError(nothingAt(name, param, value as string, text));
        if (asFile && !asFile.test(value as string)) {
          throw new ArgumentError(`${name}: the kit takes ${value as string} for an address, not for a file. ${param.description}`);
        }
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
 * Refuses a call that would have the kit lose a file in a folder of `folder` that it
 * makes again (out.replaces). Given a kit's folder in `from`, the kit deletes that folder
 * and copies the one given in its place; it then must hold nothing but a kit's own files
 * and files the copy brings back, and no file the call names. The same goes when it
 * deletes the folder to make its own, on every call or for the addresses in `addresses`.
 * For any other address the kit makes the folder again where it is, keeping what is not
 * a kit's, so only a file with a name it writes (`names`) stops it.
 */
function refuseReplacing(tool: ToolDefinition, folder: string, values: Record<string, unknown>, files: string[]): void {
  for (const [name, kind] of Object.entries(tool.out?.replaces ?? {})) {
    const dir = path.join(folder, name);
    const given = kind.from === undefined ? undefined : values[kind.from];
    let how: string;
    let why: string | undefined;
    if (typeof given === 'string') {
      if (usedInPlace(given, dir)) continue;
      // The folder the kit copies: the one given, or the folder of the file given.
      const copied = isFolder(given) ? given : path.dirname(given);
      how = `replaces the ${name} folder in ${folder} with a copy of ${copied}, deleting what is there`;
      why = namedInside(dir, files) ?? notAKitsOwn(dir, kind, copied);
    } else if (kind.addresses && !addressesOf(tool, values).some(address => inFull(kind.addresses!.pattern).test(address))) {
      if (kind.names === undefined) continue;
      how = `makes the ${name} folder in ${folder} again, which replaces a kit's own files there and any file named like one`;
      why = namedLikeOwn(dir, kind);
    } else {
      how = `replaces the ${name} folder in ${folder} with its own${kind.addresses ? ` for ${kind.addresses.about}` : ''}, deleting what is there`;
      why = namedInside(dir, files) ?? notAKitsOwn(dir, kind);
    }
    if (why) throw new ArgumentError(`${tool.name} ${how}, and ${why}. Give another out_dir, or move those files first.`);
  }
}

/**
 * The addresses a call gives, as given and as a URL parser writes them, the way a kit
 * reads them: with its host in lower case and / for \.
 */
function addressesOf(tool: ToolDefinition, values: Record<string, unknown>): string[] {
  return Object.entries(tool.params)
    .filter(([, param]) => param.type === 'url' || param.type === 'url_or_path')
    .map(([key]) => values[key])
    .filter((value): value is string => typeof value === 'string' && isUrl(value))
    .flatMap(value => {
      try {
        return [value, new URL(value).href];
      } catch {
        return [value];
      }
    });
}

function isFolder(file: string): boolean {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A file the call names that goes, or is no longer where its path leads, once `dir` is
 * deleted and made again, in words: one in it by its path, or in it by where it really
 * is. Deleting a link deletes only the link, so then only the path counts.
 */
function namedInside(dir: string, files: string[]): string | undefined {
  let link = false;
  try {
    link = lstatSync(dir).isSymbolicLink();
  } catch {
    // Not there: only a path in it could name a file in it.
  }
  const inside = files.find(file => {
    const relative = path.relative(dir, file);
    const byPath = relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    return byPath || (!link && isInside(dir, file));
  });
  return inside ? `${inside} is inside it` : undefined;
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
 * marker lists. With `copied`, the folder the kit copies in its place, a file that one
 * holds too, byte for byte, comes back, and so does a link to the same place.
 */
function notAKitsOwn(dir: string, kind: ReplacedFolder, copied?: string): string | undefined {
  try {
    if (!statSync(dir).isDirectory()) return `${dir} is a file, not a folder`;
    if (readdirSync(dir).every(entry => SYSTEM_FILES.has(entry))) return undefined;
  } catch (error) {
    // Not there, or a link to nothing: there is nothing to lose.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return `${dir} cannot be read`;
  }
  // brand/ as the link the copy makes again, when the kit given is a link.
  if (copied !== undefined && sameEntry(dir, copied)) return undefined;

  const marker = kitMarker(dir, kind);
  let others: string[];
  try {
    others = notOwn(dir, 'own' in marker ? marker.own : new Set(), copied);
  } catch {
    return `${dir} cannot be read`;
  }
  if (!others.length) return undefined;
  // A marker that is not a kit's is the reason, unless the copy brings it back.
  if ('problem' in marker && (marker.missing || copied === undefined || others.some(entry => entry === kind.marker || entry === `${kind.marker}/`))) {
    return marker.problem;
  }
  const which = [
    'own' in marker ? (kind.lists?.length ? `its ${kind.marker} does not list` : 'no kit made') : undefined,
    copied !== undefined ? 'the copy would not bring back' : undefined,
  ].filter(Boolean).join(' and ');
  return `${dir} holds ${namesInWords(others)}, which ${which}`;
}

type KitMarker = { own: Set<string> } | { problem: string; missing: boolean };

/** A kit's own files in a folder, by its marker, or why the folder holds no kit. */
function kitMarker(dir: string, kind: ReplacedFolder): KitMarker {
  const markerFile = path.join(dir, kind.marker);
  if (!existsSync(markerFile)) return { problem: `${dir} already holds other files (no ${kind.marker} in it)`, missing: true };
  let marker: unknown;
  if (kind.version !== undefined || kind.lists?.length) {
    try {
      marker = JSON.parse(readFileSync(markerFile, 'utf8'));
    } catch {
      return { problem: `${markerFile} is not one a kit made`, missing: false };
    }
    if (kind.version !== undefined && (marker as { version?: unknown } | null)?.version !== kind.version) {
      return { problem: `${markerFile} is not one a kit made (no "version": ${kind.version} in it)`, missing: false };
    }
  }
  return { own: new Set([kind.marker, ...(kind.files ?? []), ...(kind.lists ?? []).flatMap(where => listedIn(marker, where))]) };
}

/**
 * In a folder the kit makes again where it is: the files its marker does not list that
 * have a name the kit writes, in words, since the kit replaces them. Nothing when the
 * folder holds no kit, which such a kit does not start in.
 */
function namedLikeOwn(dir: string, kind: ReplacedFolder): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  const marker = kitMarker(dir, kind);
  if (!('own' in marker)) return undefined;
  const names = inFull(kind.names);
  const found = entries.filter(entry => !marker.own.has(entry) && names.test(entry)).sort();
  return found.length ? `${dir} holds ${namesInWords(found)}, which its ${kind.marker} does not list` : undefined;
}

/**
 * Whether `copy`, copied where `file` is, makes it again: the same file byte for byte,
 * or a link to the same place, since a copy turns a link into one to where it leads.
 */
function sameEntry(file: string, copy: string): boolean {
  try {
    const a = lstatSync(file);
    const b = lstatSync(copy);
    if (a.isSymbolicLink() || b.isSymbolicLink()) {
      const target = (link: string) => path.resolve(path.dirname(link), readlinkSync(link));
      return a.isSymbolicLink() && b.isSymbolicLink() && target(file) === target(copy);
    }
    if (!a.isFile() || !b.isFile() || a.size !== b.size) return false;
    if (a.dev === b.dev && a.ino === b.ino) return true;
    return readFileSync(file).equals(readFileSync(copy));
  } catch {
    return false;
  }
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
 * With `copied`, an entry the copy of that folder makes again is not among them either.
 */
function notOwn(dir: string, own: Set<string>, copied?: string): string[] {
  const found: string[] = [];
  const walk = (relative: string) => {
    const entries = readdirSync(path.join(dir, relative), { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (SYSTEM_FILES.has(entry.name)) continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const copy = copied === undefined ? undefined : path.join(copied, name);
      if (entry.isDirectory()) {
        if ([...own].some(file => file.startsWith(`${name}/`)) || (copy !== undefined && isRealFolder(copy))) walk(name);
        else found.push(`${name}/`);
      } else if (!own.has(name) && !(copy !== undefined && sameEntry(path.join(dir, name), copy))) {
        found.push(name);
      }
    }
  };
  walk('');
  return found;
}

/** A folder itself, not a link to one, as a copy makes it again. */
function isRealFolder(file: string): boolean {
  try {
    return lstatSync(file).isDirectory();
  } catch {
    return false;
  }
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

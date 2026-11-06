import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, type Dirent } from 'node:fs';
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
 * and copies the one given in its place, which therefore must be neither that folder under
 * another name, nor in it, nor around it; the folder then must hold nothing but a kit's own
 * files and files the copy brings back, and no file the call names. The same goes when it
 * deletes the folder to make its own, on every call or for the addresses in `addresses`.
 * For any other address the kit makes the folder again where it is, keeping what is not
 * a kit's, so only a file with a name it writes (`names`) in any letter case, or a link,
 * a file or another disk where it keeps a folder of its own files, stops it.
 */
function refuseReplacing(tool: ToolDefinition, folder: string, values: Record<string, unknown>, files: string[]): void {
  for (const [name, kind] of Object.entries(tool.out?.replaces ?? {})) {
    const dir = path.join(folder, name);
    const given = kind.from === undefined ? undefined : values[kind.from];
    let how: string;
    let why: string | undefined;
    let then = 'Give another out_dir, or move those files first.';
    if (typeof given === 'string') {
      if (usedInPlace(given, dir)) continue;
      // The folder the kit copies: the one given, or the folder of the file given.
      const copied = isFolder(given) ? given : path.dirname(given);
      how = `replaces the ${name} folder in ${folder} with a copy of ${copied}, deleting what is there`;
      const deleted = foldersDeleted(dir);
      const from = identity(copied);
      if (typeof deleted === 'string') {
        why = deleted;
      } else if (from !== undefined && from === identity(dir, false) && deleted.has(from)) {
        // The kit tells the two apart by their paths, so it would delete the folder it copies.
        why = `${copied} is that same folder under another name, so it would be gone before the copy`;
        then = `Give ${kind.from} as ${isFolder(given) ? dir : path.join(dir, path.basename(given))} to use it where it is.`;
      } else if (from !== undefined && deleted.has(from)) {
        why = `${copied} is inside it`;
      } else if (within(dir, copied)) {
        why = `${dir} is inside ${copied}, and a folder cannot be copied into itself`;
        then = `Give an out_dir outside ${copied}.`;
      } else {
        why = namedInside(dir, files, deleted) ?? notAKitsOwn(dir, kind, { folder: copied, deleted });
      }
    } else if (kind.addresses && !addressesOf(tool, values).some(address => inFull(kind.addresses!.pattern).test(address))) {
      if (kind.names === undefined) continue;
      how = `makes the ${name} folder in ${folder} again, which replaces a kit's own files there and any file named like one in any letter case`;
      why = namedLikeOwn(dir, kind);
    } else {
      how = `replaces the ${name} folder in ${folder} with its own${kind.addresses ? ` for ${kind.addresses.about}` : ''}, deleting what is there`;
      const deleted = foldersDeleted(dir);
      why = typeof deleted === 'string' ? deleted : namedInside(dir, files, deleted) ?? notAKitsOwn(dir, kind);
    }
    if (why) throw new ArgumentError(`${tool.name} ${how}, and ${why}. ${then}`);
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
 * A file or folder itself, as the system knows it: its disk and its number there. Every
 * path to one folder gives the same, in another letter case on a disk that ignores case,
 * through a link or through a mount, where the paths themselves differ. With `follow`
 * false, a link is itself and not what it leads to.
 */
function identity(file: string, follow = true): string | undefined {
  try {
    const stats = follow ? statSync(file, { bigint: true }) : lstatSync(file, { bigint: true });
    return `${stats.dev}:${stats.ino}`;
  } catch {
    return undefined;
  }
}

/** A path and each folder above it, up to the root. */
function ancestors(file: string): string[] {
  const found = [file];
  for (let at = file, up = path.dirname(at); up !== at; at = up, up = path.dirname(at)) found.push(up);
  return found;
}

/**
 * Whether `file` is inside `folder` by identity: a folder above it, as its path gives them
 * or with its links resolved, is that folder.
 */
function within(file: string, folder: string): boolean {
  const target = identity(folder);
  if (target === undefined) return false;
  const above = path.dirname(file);
  return [...new Set([...ancestors(above), ...ancestors(realPath(above))])].some(at => identity(at) === target);
}

/** The most folders a folder the kit deletes is searched through. */
const MOST_FOLDERS = 10000;

/**
 * The folders that go when the kit deletes `dir` with all it holds, by identity: `dir`
 * and every folder in it, mounts too. Deleting a link deletes only the link, so none when
 * `dir` is one, or is not there. When the folders cannot all be told, why, in words.
 */
function foldersDeleted(dir: string): Set<string> | string {
  const found = new Set<string>();
  try {
    if (!lstatSync(dir).isDirectory()) return found;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? found : `${dir} cannot be read`;
  }
  const waiting = [dir];
  for (let at = waiting.pop(); at !== undefined; at = waiting.pop()) {
    const id = identity(at, false);
    if (id === undefined) return `${at} cannot be read`;
    // A mount of a folder above it, met again.
    if (found.has(id)) continue;
    if (found.size === MOST_FOLDERS) return `${dir} holds more than ${MOST_FOLDERS} folders, too many to look through`;
    found.add(id);
    try {
      for (const entry of readdirSync(at, { withFileTypes: true })) {
        if (entry.isDirectory()) waiting.push(path.join(at, entry.name));
      }
    } catch {
      return `${at} cannot be read`;
    }
  }
  return found;
}

/**
 * A file the call names that goes, or is no longer where its path leads, once `dir` is
 * deleted and made again, in words: one whose path leads through `dir`, however it is
 * written, or one that really is in a folder that goes (`deleted`). Deleting a link
 * deletes only the link, so then only the path counts.
 */
function namedInside(dir: string, files: string[], deleted: Set<string>): string | undefined {
  const self = identity(dir, false);
  const inside = files.find(file => {
    if (self !== undefined && ancestors(file).some(at => identity(at, false) === self)) return true;
    const real = realPath(file);
    const id = identity(isFolder(real) ? real : path.dirname(real));
    return id !== undefined && deleted.has(id);
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

/** The folder a kit copies in place of the one it deletes. */
interface Copy {
  folder: string;
  /** The folders deleting the other one deletes, by identity. */
  deleted: Set<string>;
}

/**
 * What in a folder the kit would delete is not a kit's own, in words. Nothing when the
 * folder is not there, is empty, or holds only its marker, its files and what the
 * marker lists. With `copy`, the folder the kit copies in its place, a file that one holds
 * too under the same name, byte for byte, comes back, and so does a link to the same place.
 */
function notAKitsOwn(dir: string, kind: ReplacedFolder, copy?: Copy): string | undefined {
  try {
    if (!statSync(dir).isDirectory()) return `${dir} is a file, not a folder`;
    if (readdirSync(dir).every(entry => SYSTEM_FILES.has(entry))) return undefined;
  } catch (error) {
    // Not there, or a link to nothing: there is nothing to lose.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return `${dir} cannot be read`;
  }
  // brand/ as the link the copy makes again, when the kit given is a link.
  if (copy !== undefined && sameEntry(dir, copy.folder)) return undefined;

  const marker = kitMarker(dir, kind);
  let others: string[];
  try {
    others = notOwn(dir, 'own' in marker ? marker.own : new Set(), copy);
  } catch {
    return `${dir} cannot be read`;
  }
  if (!others.length) return undefined;
  // A marker that is not a kit's is the reason, unless the copy brings it back.
  if ('problem' in marker && (marker.missing || copy === undefined || others.some(entry => entry === kind.marker || entry === `${kind.marker}/`))) {
    return marker.problem;
  }
  const which = [
    'own' in marker ? (kind.lists?.length ? `its ${kind.marker} does not list` : 'no kit made') : undefined,
    copy !== undefined ? 'the copy would not bring back' : undefined,
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
 * A name the way a disk that ignores letter case compares it, as near as can be told:
 * its accents in one form, without the marks some disks leave out, in small letters.
 */
function folded(name: string): string {
  return name.normalize('NFC').replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g, '').toUpperCase().toLowerCase();
}

/**
 * In a folder the kit makes again where it is: what of it the kit would replace or
 * delete that is not a kit's own, in words. The kit writes and deletes its files by name,
 * and on a disk that ignores letter case a name in other letters is the same file, so a
 * name counts in any letter case here, and only one written the way the kit writes it is
 * a kit's own. Where the kit keeps a folder of its files, like pages, a link, a file or
 * another disk mounted there would have it delete or write files elsewhere, and a folder
 * by that name in other letters holds none of its own. Nothing when the folder holds no
 * kit, which such a kit does not start in.
 */
function namedLikeOwn(dir: string, kind: ReplacedFolder): string | undefined {
  try {
    if (!readdirSync(dir).length) return undefined;
  } catch {
    return undefined;
  }
  const marker = kitMarker(dir, kind);
  if (!('own' in marker)) return undefined;
  const own = marker.own;
  const written = new Set([...own].map(folded));
  // The folders the kit's own files are in, like pages for pages/home.md, as the kit writes them.
  const places = new Map([...own].flatMap(file => file.split('/').slice(0, -1)
    .map((_, i, parts) => parts.slice(0, i + 1).join('/'))).map(place => [folded(place), place]));
  const names = new RegExp(`^(?:${kind.names ?? '(?!)'})$`, 'i');
  const found: string[] = [];
  let elsewhere: string | undefined;
  const walk = (relative: string) => {
    for (const entry of readdirSync(path.join(dir, relative), { withFileTypes: true }).sort(byName)) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const key = folded(name);
      const place = places.get(key);
      const full = path.join(dir, name);
      if (place === name && entry.isDirectory()) {
        // A disk mounted there is another place, as a link is. One mounted from the same disk looks like any folder.
        if (lstatSync(full).dev === statSync(path.join(dir, relative)).dev) walk(name);
        else elsewhere ??= `${full} is another disk mounted there, so the kit would delete files named like its own on it`;
      } else if (place !== undefined) {
        elsewhere ??= entry.isSymbolicLink()
          ? `${full} is a link, so the kit would delete files named like its own where it leads`
          : entry.isDirectory()
            ? `${full} is named like the kit's ${place} folder in other letters, which a disk that ignores letter case takes for that one`
            : `${full} is a file where the kit keeps its ${place} folder`;
      } else if (written.has(key) || (!relative && names.test(folded(entry.name)))) {
        if (!own.has(name) || entry.isDirectory()) found.push(entry.isDirectory() ? `${name}/` : name);
      }
    }
  };
  try {
    walk('');
  } catch {
    return `${dir} cannot be read`;
  }
  const why = [found.length ? `${dir} holds ${namesInWords(found)}, which its ${kind.marker} does not list` : undefined, elsewhere];
  return why.filter(Boolean).join(', and ') || undefined;
}

/**
 * Whether `copy`, copied where `file` is, makes it again: the same file byte for byte,
 * or a link to the same place, since a copy turns a link into one to where it leads.
 * The two are compared by their bytes, never by identity: one file under two names goes
 * with the folder deleted, and notOwn leaves out a folder of the copy that goes too.
 */
function sameEntry(file: string, copy: string): boolean {
  try {
    const a = lstatSync(file);
    const b = lstatSync(copy);
    if (a.isSymbolicLink() || b.isSymbolicLink()) {
      const target = (link: string) => path.resolve(path.dirname(link), readlinkSync(link));
      return a.isSymbolicLink() && b.isSymbolicLink() && target(file) === target(copy);
    }
    return a.isFile() && b.isFile() && a.size === b.size && readFileSync(file).equals(readFileSync(copy));
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

const byName = (a: Dirent, b: Dirent) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * The entries of a folder that are not among its own files, like notes.md or drafts/,
 * in name order. Links are entries like files: deleting one leaves what it points to.
 * With `copy`, an entry the copy of that folder makes again is not among them either:
 * one it holds under the very same name, in a folder of it that is not deleted too.
 */
function notOwn(dir: string, own: Set<string>, copy?: Copy): string[] {
  const found: string[] = [];
  const walk = (relative: string) => {
    const entries = readdirSync(path.join(dir, relative), { withFileTypes: true }).sort(byName);
    const there = copy === undefined ? undefined : namesIn(path.join(copy.folder, relative), copy.deleted);
    for (const entry of entries) {
      if (SYSTEM_FILES.has(entry.name)) continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const back = there?.has(entry.name) ? path.join(copy!.folder, name) : undefined;
      if (entry.isDirectory()) {
        if ([...own].some(file => file.startsWith(`${name}/`)) || (back !== undefined && isRealFolder(back))) walk(name);
        else found.push(`${name}/`);
      } else if (!own.has(name) && !(back !== undefined && sameEntry(path.join(dir, name), back))) {
        found.push(name);
      }
    }
  };
  walk('');
  return found;
}

/**
 * The names in a folder of the copy, as they are written, or none when that folder is not
 * there, or goes too with the folder deleted, like one mounted from it.
 */
function namesIn(folder: string, deleted: Set<string>): Set<string> | undefined {
  const id = identity(folder);
  if (id === undefined || deleted.has(id)) return undefined;
  try {
    return new Set(readdirSync(folder));
  } catch {
    return undefined;
  }
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

import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InstalledKit, ParamDefinition, ToolDefinition } from './kits.js';

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
        refuseReplacing(tool, folder, files);
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
  if (param.type === 'text_or_path') {
    return `${name}: there is nothing at ${full}, and "${text}" is not text the kit takes. ${param.description}`;
  }
  return `${name}: there is nothing at ${full}`;
}

/**
 * Refuses a call that would have the kit delete a folder in `folder` it replaces with
 * its own (out.replaces) while that folder holds files no kit made there, or a file the
 * call itself names. A folder the call names is used where it is, so it stays.
 */
function refuseReplacing(tool: ToolDefinition, folder: string, files: string[]): void {
  for (const [name, marker] of Object.entries(tool.out?.replaces ?? {})) {
    const dir = path.join(folder, name);
    if (!existsSync(dir)) continue;
    try {
      if (statSync(dir).isDirectory() && readdirSync(dir).length === 0) continue;
    } catch {
      // Not readable: count it as full.
    }
    if (files.some(file => file === dir || file === path.join(dir, marker))) continue;
    const inside = files.find(file => isInside(dir, file));
    const why = inside
      ? `${inside} is inside it`
      : !existsSync(path.join(dir, marker)) ? `${dir} already holds other files (no ${marker} in it)` : undefined;
    if (why) {
      throw new ArgumentError(
        `${tool.name} replaces the ${name} folder in ${folder} with its own, deleting what is there, and ${why}. `
        + `Give another out_dir, or move those files first.`,
      );
    }
  }
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

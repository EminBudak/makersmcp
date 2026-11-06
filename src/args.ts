import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InstalledKit, ToolDefinition } from './kits.js';

/** A tool call that cannot become a command, like a file that is not there. */
export class ArgumentError extends Error {}

export interface BuiltCommand {
  args: string[];
  /** Where the kit writes, when it is known. */
  folder?: string;
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

/** The host part of a folder name, the way the kits name theirs: launch-film-linear.app. */
export function hostOf(value: string): string | undefined {
  if (!isUrl(value)) return undefined;
  try {
    return new URL(value).hostname.replace(/^www\./, '').replace(/[^a-z0-9.-]/gi, '-');
  } catch {
    return undefined;
  }
}

/**
 * Turns a tool call into the kit's arguments: the positional ones from `args`,
 * then a flag for each parameter given, then the folder and the other kits the
 * tool uses. Relative paths are read from baseDir, where the folders go too.
 */
export function buildCommand(
  tool: ToolDefinition,
  input: Record<string, unknown>,
  context: { baseDir: string; installed: Map<string, InstalledKit> },
): BuiltCommand {
  const values: Record<string, unknown> = {};
  for (const [name, param] of Object.entries(tool.params)) {
    let value = input[name];
    if (value === undefined || value === null || value === '') continue;
    if (param.type === 'path' || (param.type === 'url_or_path' && !isUrl(String(value)))) {
      value = path.resolve(context.baseDir, expandHome(String(value)));
      if (!existsSync(value as string)) throw new ArgumentError(`${name}: there is nothing at ${value}`);
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
    const named = given !== undefined ? expandHome(given) : fill(tool.out.name, tool, values);
    if (named !== undefined) {
      folder = path.resolve(context.baseDir, named);
      if (tool.out.flag) args.push(tool.out.flag, folder);
    } else if (tool.out.otherwise) {
      const other = fill(tool.out.otherwise, tool, values);
      if (other !== undefined) folder = path.resolve(context.baseDir, other);
    }
  }

  for (const [flag, kit] of Object.entries(tool.uses ?? {})) {
    const other = context.installed.get(kit);
    if (other) args.push(flag, other.script);
  }

  return { args, folder };
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

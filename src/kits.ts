import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A kit is a command line tool in its own repository and npm package. makersmcp
 * knows nothing about any kit in code: each one is described by a JSON file in
 * kits/, and that file says which package to run, which tools it has and how
 * each tool's parameters become the kit's arguments.
 */

export type ParamType =
  | 'url'
  | 'url_or_path'
  | 'path'
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'list'
  | 'repeat';

export interface ParamDefinition {
  type: ParamType;
  description: string;
  required?: boolean;
  /** The kit's flag. A parameter without one is used in `args`. */
  flag?: string;
  /** For booleans: the flag is passed when the value equals this (default true). */
  when?: boolean;
  /** Allowed values for enum, and for each item of a list. */
  values?: string[];
  min?: number;
  max?: number;
}

export interface OutDefinition {
  /** The kit's flag for its folder. Without one, the folder is only reported. */
  flag?: string;
  /** The folder's name, with {host}, {dir:param} and {stem:param}. */
  name: string;
  /** Used without the flag when `name` cannot be filled, like {host} for a file. */
  otherwise?: string;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  /** The kit's positional arguments, like ["demo", "{url}"]. */
  args: string[];
  params: Record<string, ParamDefinition>;
  out?: OutDefinition;
  /** Markdown files in the folder to return with the result. */
  docs?: string[];
  /** Exit code 1 is a failed check, a normal result, not an error. */
  check?: boolean;
  readOnly?: boolean;
  /** Flags that take another kit's script, like { "--easybrandkit": "easybrandkit" }. */
  uses?: Record<string, string>;
}

export interface KitDefinition {
  kit: string;
  package: string;
  /** The package's bin to run, when it has more than one. */
  bin?: string;
  field: string;
  about: string;
  repository: string;
  needs: string[];
  tools: ToolDefinition[];
}

export interface InstalledKit {
  definition: KitDefinition;
  dir: string;
  script: string;
  version: string;
}

export interface MissingKit {
  definition: KitDefinition;
  reason: string;
}

const PARAM_TYPES = new Set<ParamType>([
  'url', 'url_or_path', 'path', 'string', 'integer', 'number', 'boolean', 'enum', 'list', 'repeat',
]);
const NAME = /^[a-z][a-z0-9_]*$/;
const RESERVED_PARAMS = new Set(['out_dir', 'wait_seconds']);

export const KITS_DIR = fileURLToPath(new URL('../kits/', import.meta.url));

/** Reads every kit definition in a folder, kits/ by default. */
export function loadKitDefinitions(dir: string = KITS_DIR): KitDefinition[] {
  return readdirSync(dir)
    .filter(file => file.endsWith('.json'))
    .sort()
    .map(file => {
      const definition = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as KitDefinition;
      validateKitDefinition(definition, file);
      return definition;
    });
}

/** Throws on a definition that would register broken tools. */
export function validateKitDefinition(definition: KitDefinition, where = definition.kit): void {
  const fail = (message: string): never => {
    throw new Error(`${where}: ${message}`);
  };
  if (!definition.kit || !definition.package) fail('needs kit and package');
  if (!Array.isArray(definition.tools) || definition.tools.length === 0) fail('needs at least one tool');
  for (const tool of definition.tools) {
    if (!NAME.test(tool.name)) fail(`tool name "${tool.name}" must be snake_case`);
    if (!tool.title || !tool.description) fail(`${tool.name} needs a title and a description`);
    for (const [name, param] of Object.entries(tool.params)) {
      if (!NAME.test(name) || RESERVED_PARAMS.has(name)) fail(`${tool.name}: "${name}" cannot be a parameter name`);
      if (!PARAM_TYPES.has(param.type)) fail(`${tool.name}.${name}: unknown type "${param.type}"`);
      if (param.type === 'enum' && !param.values?.length) fail(`${tool.name}.${name}: an enum needs values`);
      if (param.flag !== undefined && !/^--?[a-z]/.test(param.flag)) fail(`${tool.name}.${name}: bad flag "${param.flag}"`);
      const used = tool.args.some(arg => arg === `{${name}}`);
      if (!param.flag && !used) fail(`${tool.name}.${name}: needs a flag or a place in args`);
      if (used && !param.required) fail(`${tool.name}.${name}: a positional parameter must be required`);
    }
    for (const arg of tool.args) {
      const match = /^\{(\w+)\}$/.exec(arg);
      if (match && !tool.params[match[1]]) fail(`${tool.name}: args use {${match[1]}}, which is not a parameter`);
    }
  }
}

/**
 * Finds a kit's package: the path given for it in kitPaths when there is one
 * (a checkout, for development), else the package installed next to makersmcp.
 */
export function resolveKit(
  definition: KitDefinition,
  kitPaths: Record<string, string> = {},
): InstalledKit | MissingKit {
  let dir: string;
  const given = kitPaths[definition.kit];
  if (given) {
    dir = path.resolve(given);
    if (!existsSync(path.join(dir, 'package.json'))) {
      return { definition, reason: `no package.json in ${dir}` };
    }
  } else {
    try {
      const require = createRequire(import.meta.url);
      dir = path.dirname(require.resolve(`${definition.package}/package.json`));
    } catch {
      return { definition, reason: `the ${definition.package} package is not installed` };
    }
  }

  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
    version?: string;
    bin?: string | Record<string, string>;
  };
  const bin = typeof pkg.bin === 'string'
    ? pkg.bin
    : pkg.bin?.[definition.bin ?? definition.package] ?? Object.values(pkg.bin ?? {})[0];
  if (!bin) return { definition, reason: `${definition.package} has no bin to run` };
  const script = path.join(dir, bin);
  if (!existsSync(script)) return { definition, reason: `${script} is missing` };
  return { definition, dir, script, version: pkg.version ?? '?' };
}

export function isInstalled(kit: InstalledKit | MissingKit): kit is InstalledKit {
  return 'script' in kit;
}

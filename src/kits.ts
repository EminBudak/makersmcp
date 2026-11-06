import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandHome } from './args.js';

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
  | 'text_or_path'
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
  /**
   * What the agent reads instead when the kits run on a hosted server, where a file
   * comes as a link or as job:<job_id>/<path>. It replaces the usual words about links.
   */
  hostedDescription?: string;
  required?: boolean;
  /** The kit's flag. A parameter without one is used in `args`. */
  flag?: string;
  /** For booleans: the flag is passed when the value equals this (default true). */
  when?: boolean;
  /** Allowed values for enum, and for each item of a list. */
  values?: string[];
  /**
   * For text_or_path: a regular expression for the text the kit takes, like a list of
   * seconds. A value it does not match in full is a file.
   */
  pattern?: string;
  /**
   * For url_or_path, when the kit tells a file from an address by the value itself: a
   * regular expression for the values it takes for a file, matched in full, like any
   * value that ends in .json. A link it matches is refused, since the kit would look for
   * it on disk, and so is a file it does not match, since the kit would read it as an address.
   */
  filePattern?: string;
  min?: number;
  max?: number;
}

export interface OutDefinition {
  /** The kit's flag for its folder. Without one, the folder is only reported. */
  flag?: string;
  /** The folder's name, with {host}, {dir:param} and {stem:param}. */
  name: string;
  /**
   * Where the kit saves when `name` cannot be filled, like {host} for a file. The kit
   * picks that folder itself and takes no flag for it, so out_dir cannot move it.
   */
  otherwise?: string;
  /**
   * Folders in the folder given with `flag` that the kit deletes and makes again, like
   * brand, each with how to tell one a kit made. makersmcp does not start the kit when it
   * finds the kit would lose anything else there. It tells folders apart by what the disk
   * says they are, so another letter case, a link or a mount does not hide one, but it
   * looks only before the kit starts.
   */
  replaces?: Record<string, ReplacedFolder>;
}

/** A folder a kit deletes and makes again, and the files a kit puts in one. */
export interface ReplacedFolder {
  /** The file such a folder always holds, like brand.json. */
  marker: string;
  /** The marker is JSON, and its "version" is this, like 1. */
  version?: number;
  /** The other files a kit writes there, like BRAND.md or pages/home.md. */
  files?: string[];
  /**
   * Where the marker, read as JSON, names the rest of the files, by name: logos.file is
   * the file of each of its logos, and stores.assets.file each file of each store's assets.
   */
  lists?: string[];
  /**
   * The parameter that gives the kit a folder like this to copy in, as the folder or a
   * file in it. When that is this folder by its path, the kit uses it where it is and
   * deletes nothing. Any other, it deletes this folder and copies that one in its place, so
   * a file that one holds too under the same name, byte for byte, comes back. This folder
   * under another path, a folder in it and one around it are refused: the kit would delete
   * the folder it copies, or copy a folder into itself.
   */
  from?: string;
  /**
   * When the kit, not given `from`, deletes the folder only for some addresses, like an
   * App Store page's: those addresses. For any other one it makes the folder again where
   * it is, replacing a kit's own files and keeping the rest.
   */
  addresses?: ReplacedFor;
  /**
   * The other names a kit writes in such a folder, as a regular expression matched in
   * full, like logo-\d+\.png. Making the folder again where it is, the kit replaces a file
   * with such a name even when the marker does not list it.
   */
  names?: string;
}

/** The addresses a kit deletes a folder for. */
export interface ReplacedFor {
  /** A regular expression for them, matched in full against the address as given and as a URL parser writes it. */
  pattern: string;
  /** What they are, in words, like "an App Store page". */
  about: string;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  /** The description when the kits run on a hosted server, where the agent has no files of its own. */
  hostedDescription?: string;
  /** The kit's positional arguments, like ["demo", "{url}"]. */
  args: string[];
  params: Record<string, ParamDefinition>;
  out?: OutDefinition;
  /** Markdown files in the folder to return with the result. */
  docs?: string[];
  /** Exit code 1 is a failed check, a normal result, not an error. */
  check?: boolean;
  /**
   * For a check: what the kit writes once the check has run, "stdout" or a file in the
   * folder. Exit code 1 without it means the check could not run, and the job failed.
   */
  report?: string;
  readOnly?: boolean;
  /** The tool may delete or replace files that are already in its folder, so a client may ask first. */
  destructive?: boolean;
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
  'url', 'url_or_path', 'path', 'text_or_path', 'string', 'integer', 'number', 'boolean', 'enum', 'list', 'repeat',
]);
const NAME = /^[a-z][a-z0-9_]*$/;
const RESERVED_PARAMS = new Set(['out_dir', 'wait_seconds']);
// A place in a marker file, like logos.file.
const LISTED = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;

/** A path that stays inside the folder it is read from, like brand or stills/STILLS.md. */
function staysInside(relative: string): boolean {
  return Boolean(relative) && !path.isAbsolute(relative) && !relative.split(/[\\/]/).includes('..');
}

function isPattern(value: unknown): boolean {
  if (typeof value !== 'string' || !value) return false;
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}

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
    if (tool.hostedDescription !== undefined && !tool.hostedDescription) fail(`${tool.name}: an empty hostedDescription`);
    for (const [name, param] of Object.entries(tool.params)) {
      if (!NAME.test(name) || RESERVED_PARAMS.has(name)) fail(`${tool.name}: "${name}" cannot be a parameter name`);
      if (!PARAM_TYPES.has(param.type)) fail(`${tool.name}.${name}: unknown type "${param.type}"`);
      if (param.type === 'enum' && !param.values?.length) fail(`${tool.name}.${name}: an enum needs values`);
      if (param.flag !== undefined && !/^--?[a-z]/.test(param.flag)) fail(`${tool.name}.${name}: bad flag "${param.flag}"`);
      if (param.hostedDescription !== undefined && !param.hostedDescription) fail(`${tool.name}.${name}: an empty hostedDescription`);
      if (param.type === 'text_or_path') {
        if (!param.pattern) fail(`${tool.name}.${name}: text_or_path needs the pattern of its text`);
        if (!isPattern(param.pattern)) fail(`${tool.name}.${name}: the pattern is not a regular expression`);
      } else if (param.pattern !== undefined) {
        fail(`${tool.name}.${name}: only text_or_path takes a pattern`);
      }
      if (param.filePattern !== undefined) {
        if (param.type !== 'url_or_path') fail(`${tool.name}.${name}: only url_or_path takes a filePattern`);
        if (!isPattern(param.filePattern)) fail(`${tool.name}.${name}: the filePattern is not a regular expression`);
      }
      if ((param.min !== undefined || param.max !== undefined) && param.type !== 'integer' && param.type !== 'number') {
        fail(`${tool.name}.${name}: only numbers take min and max`);
      }
      if (param.min !== undefined && param.max !== undefined && param.min > param.max) fail(`${tool.name}.${name}: min is above max`);
      const used = tool.args.some(arg => arg === `{${name}}`);
      if (!param.flag && !used) fail(`${tool.name}.${name}: needs a flag or a place in args`);
      if (used && !param.required) fail(`${tool.name}.${name}: a positional parameter must be required`);
    }
    for (const arg of tool.args) {
      const match = /^\{(\w+)\}$/.exec(arg);
      if (match && !tool.params[match[1]]) fail(`${tool.name}: args use {${match[1]}}, which is not a parameter`);
    }
    if (tool.report !== undefined) {
      if (!tool.check) fail(`${tool.name}: only a check has a report`);
      if (tool.report !== 'stdout' && (!tool.out || !staysInside(tool.report))) {
        fail(`${tool.name}: report is "stdout" or a file in the tool's folder`);
      }
    }
    for (const [folder, kind] of Object.entries(tool.out?.replaces ?? {})) {
      const where = `${tool.name}: replaces.${folder}`;
      if (!tool.out?.flag) fail(`${tool.name}: replaces needs out.flag`);
      if (!kind || typeof kind !== 'object' || typeof kind.marker !== 'string') fail(`${where} needs a marker, the file such a folder holds`);
      if (kind.files !== undefined && !Array.isArray(kind.files)) fail(`${where}: files is a list`);
      if (![folder, kind.marker, ...(kind.files ?? [])].every(name => typeof name === 'string' && staysInside(name))) {
        fail(`${where}: it names folders and files inside the tool's folder`);
      }
      if (kind.version !== undefined && typeof kind.version !== 'number') fail(`${where}: version is a number`);
      if (kind.lists !== undefined && !(Array.isArray(kind.lists) && kind.lists.every(entry => typeof entry === 'string' && LISTED.test(entry)))) {
        fail(`${where}: lists are places in the marker, like logos.file`);
      }
      if (kind.from !== undefined && tool.params[kind.from]?.type !== 'path') fail(`${where}: from names a path parameter`);
      if (kind.addresses !== undefined) {
        const { pattern, about } = (kind.addresses ?? {}) as Partial<ReplacedFor>;
        if (!isPattern(pattern) || typeof about !== 'string' || !about) {
          fail(`${where}: addresses are a pattern, a regular expression, and about, what they are in words`);
        }
        if (!Object.values(tool.params).some(param => param.type === 'url' || param.type === 'url_or_path')) {
          fail(`${where}: addresses need a parameter that takes an address`);
        }
      }
      if (kind.names !== undefined) {
        if (!isPattern(kind.names)) fail(`${where}: names is a regular expression`);
        // Only a kit that makes the folder again where it is, for the other addresses, replaces files by their names.
        if (kind.addresses === undefined) fail(`${where}: names need addresses`);
      }
    }
  }
}

/**
 * Finds a kit's package: the path given for it in kitPaths when there is one
 * (a checkout, for development; a leading ~ is the home folder), else the package
 * installed next to makersmcp.
 */
export function resolveKit(
  definition: KitDefinition,
  kitPaths: Record<string, string> = {},
): InstalledKit | MissingKit {
  let dir: string;
  const given = kitPaths[definition.kit];
  if (given) {
    // A client's JSON settings and MAKERSMCP_KIT_PATHS reach makersmcp without a shell to read ~.
    dir = path.resolve(expandHome(given));
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

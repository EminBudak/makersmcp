import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { ArgumentError, buildCommand, expandHome } from './args.js';
import {
  NotStartedError,
  type AvailableKit,
  type JobDoc,
  type JobFile,
  type JobView,
  type KitBackend,
  type SetupOptions,
  type StartRequest,
  type UnavailableKit,
  type WaitOptions,
} from './backend.js';
import { FolderBusyError, JobManager, launcherProblem, type Job } from './jobs.js';
import { isInstalled, resolveKit, type InstalledKit, type KitDefinition, type MissingKit } from './kits.js';
import { setupReport } from './setup.js';

const MAX_FILES = 200;
// Entries looked at in one listing, so a folder that holds a whole project stays quick.
const MAX_ENTRIES = 20_000;
// Some file systems keep the time a file changed to the second, or to two.
const MTIME_SLACK_MS = 2000;
const MAX_DOC_CHARS = 40_000;
// The most of a doc that is read: more bytes than MAX_DOC_CHARS characters take, so a longer doc is still cut.
const MAX_DOC_BYTES = 4 * MAX_DOC_CHARS;
// Windows has neither: there a doc is checked for a link before it is opened.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;
const HEAD_LINES = 5;
const TAIL_LINES = 30;

/** Never listed: hidden files and folders, like .git and a kit's .work- folders, and node_modules. */
function skipped(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules';
}

/** Whether `target` is `root` or inside it, as both are written. */
function contains(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** A folder with its links resolved, or nothing when it is not there. */
function resolved(folder: string): string | undefined {
  try {
    return realpathSync(folder);
  } catch {
    return undefined;
  }
}

/**
 * The files in a folder, relative to it, at most MAX_FILES: a folder's own files in
 * name order before the files in its subfolders. With `since`, only the files changed
 * from then on, which for a job are the files it saved, whatever the folder held before.
 * Links are left out, and no folder is entered through one. With `within`, for a folder
 * a kit wrote under confine, a folder that leads out of `within`, like one a kit swapped
 * for a link, is not looked in: given such a folder, it lists nothing.
 */
export function listFiles(folder: string, since?: number, within?: string): JobFile[] {
  const files: JobFile[] = [];
  const root = within === undefined ? undefined : resolved(within);
  if (within !== undefined && root === undefined) return files;
  const queue = [folder];
  let seen = 0;
  while (queue.length && files.length < MAX_FILES && seen < MAX_ENTRIES) {
    const dir = queue.shift()!;
    if (root !== undefined) {
      const real = resolved(dir);
      if (real === undefined || !contains(root, real)) continue;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const sorted = entries.filter(entry => !skipped(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of sorted) {
      if (files.length >= MAX_FILES || ++seen > MAX_ENTRIES) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      let stat;
      try {
        // Not stat: a file swapped for a link since the folder was read is a link here, and left out.
        stat = lstatSync(full);
      } catch {
        // Gone since the folder was read, like a lock file or a kit's work file.
        continue;
      }
      if (!stat.isFile()) continue;
      if (since !== undefined && stat.mtimeMs < since - MTIME_SLACK_MS) continue;
      files.push({ path: path.relative(folder, full), bytes: stat.size });
    }
  }
  return files;
}

/**
 * Whether the file opened, `opened`, is `file` as reached from `within` through folders
 * and no link: each step on the way a folder itself, and the file at the end that very
 * file, which still has one name. A folder on the way swapped for a link fails the first
 * check while it is one, and the second once it is swapped back.
 */
function reachedFrom(within: string, file: string, fd: number, opened: BigIntStats): boolean {
  if (!contains(within, file)) return false;
  const steps = path.relative(within, file).split(path.sep);
  let at = within;
  for (const [i, step] of steps.entries()) {
    at = path.join(at, step);
    const stat = lstatSync(at, { bigint: true });
    if (i < steps.length - 1 ? !stat.isDirectory() : stat.dev !== opened.dev || stat.ino !== opened.ino) return false;
  }
  return fstatSync(fd, { bigint: true }).nlink === 1n;
}

/**
 * A doc's text, or nothing when it is not a file to read. A kit wrote the folder, and it
 * may run as another user than this process: a doc is opened without following a link,
 * which could lead to a file only this process's user may read, and without waiting on a
 * fifo, which would hold this process. It is read only when it is a regular file with one
 * name, since a second name, a hard link, makes it a file of elsewhere too, and with
 * `within` only when it is reached from there through folders and no link.
 */
function readDoc(file: string, within?: string): string | undefined {
  let fd: number;
  try {
    if (!NOFOLLOW && lstatSync(file).isSymbolicLink()) return undefined;
    fd = openSync(file, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) return undefined;
    if (within !== undefined && !reachedFrom(within, file, fd, stat)) return undefined;
    const buffer = Buffer.alloc(Number(stat.size < MAX_DOC_BYTES ? stat.size : MAX_DOC_BYTES));
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, length);
      if (read === 0) break;
      length += read;
    }
    return buffer.subarray(0, length).toString('utf8');
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * The kit's notes in a folder, cut at MAX_DOC_CHARS each. A doc that is not a regular file
 * with one name, like a link, a fifo or a hard link, is left out as a missing one is, and
 * so is one not reached from `within` through folders, when that is given (readDoc).
 */
export function readDocs(folder: string, names: string[] = [], within?: string): JobDoc[] {
  const docs: JobDoc[] = [];
  for (const name of names) {
    const file = path.join(folder, name);
    const text = readDoc(file, within);
    if (text === undefined) continue;
    docs.push(text.length > MAX_DOC_CHARS
      ? { name, text: text.slice(0, MAX_DOC_CHARS), more: file }
      : { name, text });
  }
  return docs;
}

function tail(text: string, lines = TAIL_LINES): string {
  return text.trim().split(/\r?\n/).slice(-lines).join('\n');
}

/**
 * What a failed kit said on stderr, for the agent. An argument error (exit code 2) gives
 * its reason first and the kit's usage after it: the reason is kept, the usage is not.
 * A long log keeps its first lines and its last ones, where an error usually is.
 */
export function failureText(stderr: string, exitCode: number | null): string {
  let lines = stderr.split(/\r?\n/);
  if (exitCode === 2) {
    const usage = lines.findIndex(line => /^Usage:/.test(line));
    if (usage > 0 && lines.slice(0, usage).some(line => line.trim())) lines = lines.slice(0, usage);
  }
  while (lines.length && !lines[0]!.trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  if (lines.length > HEAD_LINES + TAIL_LINES + 1) {
    const cut = lines.length - HEAD_LINES - TAIL_LINES;
    lines = [...lines.slice(0, HEAD_LINES), `(${cut} more lines)`, ...lines.slice(-TAIL_LINES)];
  }
  return lines.join('\n');
}

/** A job of this machine as the tools show it. */
export function viewJob(job: Job): JobView {
  const { spec } = job;
  const view: JobView = {
    id: job.id,
    kit: spec.kit,
    tool: spec.tool,
    title: spec.title,
    status: job.status,
    ...(spec.check ? { check: true } : {}),
    exitCode: job.exitCode,
    elapsedSeconds: job.elapsedSeconds,
    ...(spec.folder ? { folder: spec.folder } : {}),
    // A failed kit's last line is often the end of its usage text: the failure says what went wrong.
    ...(job.lastLine && job.status !== 'failed' ? { lastLine: job.lastLine } : {}),
  };
  if (job.status === 'failed') {
    view.failure = [failureText(job.stderr, job.exitCode), tail(job.stdout, 10)].filter(Boolean).join('\n\n');
  }
  if (job.status === 'done') {
    // What the kit said at the end: its summary on stdout, or its last lines when it writes only to stderr.
    view.summary = job.stdout.trim() || tail(job.stderr, 12);
    if (spec.folder) {
      view.files = listFiles(spec.folder, job.startedAt, spec.within);
      view.docs = readDocs(spec.folder, spec.docs, spec.within);
    }
  }
  return view;
}

export interface LocalBackendOptions {
  /** Where kits save, and what relative paths are read from. A leading ~ is the home folder. */
  baseDir: string;
  /** A kit's folder to use instead of its installed package, like { musicfit: '../musicfit' }. A leading ~ is the home folder. */
  kitPaths?: Record<string, string>;
  /** The environment kits run with. Default: this process's. A service can keep its own secrets from them. */
  env?: NodeJS.ProcessEnv;
  /**
   * Refuse every file and folder outside baseDir, like an out_dir or a file elsewhere.
   * For a service that brings each job's inputs into the job's own baseDir. A job then
   * also returns only docs and files a kit left inside baseDir (listFiles, readDocs).
   */
  confine?: boolean;
  /**
   * A command that starts each kit's supervisor in place of node, for a service whose
   * kits run as another user, like ['sudo', '-n', '-u', '<kit user>', '--', '<wrapper>', 'run']
   * (JobSpec.launcher). A cancel then ends the supervisor's stdin, since no signal reaches
   * another user's process, and Job.pid is the process group the launcher's own clean-up
   * keeps while the job runs.
   */
  launcher?: string[];
}

/** Runs kits on this machine, each job a process of its own, saving into baseDir. */
export class LocalBackend implements KitBackend {
  readonly where = 'local';
  readonly place = 'on this machine';
  readonly baseDir: string;
  readonly jobs = new JobManager();
  private readonly kitPaths?: Record<string, string>;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly confine: boolean;
  private readonly launcher?: string[];
  private kits: Array<InstalledKit | MissingKit> = [];
  private readonly installed = new Map<string, InstalledKit>();

  constructor(options: LocalBackendOptions) {
    this.baseDir = path.resolve(expandHome(options.baseDir));
    this.kitPaths = options.kitPaths;
    this.env = options.env;
    this.confine = options.confine === true;
    if (options.launcher !== undefined) {
      const problem = launcherProblem(options.launcher);
      if (problem) throw new TypeError(problem);
      this.launcher = [...options.launcher];
    }
  }

  available(definitions: KitDefinition[]): Array<AvailableKit | UnavailableKit> {
    this.kits = definitions.map(definition => resolveKit(definition, this.kitPaths));
    this.installed.clear();
    for (const kit of this.kits) if (isInstalled(kit)) this.installed.set(kit.definition.kit, kit);
    return this.kits;
  }

  async start({ kit, tool, input }: StartRequest): Promise<JobView> {
    const installed = this.installed.get(kit.definition.kit);
    if (!installed) throw new NotStartedError(`${kit.definition.kit} is not installed here.`);

    let command;
    try {
      command = buildCommand(tool, input, { baseDir: this.baseDir, installed: this.installed, confine: this.confine });
    } catch (error) {
      if (error instanceof ArgumentError) throw new NotStartedError(error.message);
      throw error;
    }

    // Every kit runs in baseDir, and on a first run, like ~/makersmcp, it is not there yet.
    try {
      mkdirSync(this.baseDir, { recursive: true });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new NotStartedError(
        `Cannot make ${this.baseDir}, the folder the kits save in: ${reason}. Set --out or MAKERSMCP_OUT to a folder you can write to.`,
      );
    }

    try {
      return viewJob(this.jobs.start({
        kit: installed.definition.kit,
        tool: tool.name,
        title: tool.title,
        script: installed.script,
        args: command.args,
        cwd: this.baseDir,
        folder: command.folder,
        docs: tool.docs,
        check: tool.check,
        report: tool.report,
        env: this.env,
        ...(this.launcher ? { launcher: this.launcher } : {}),
        ...(this.confine ? { within: this.baseDir } : {}),
      }));
    } catch (error) {
      if (error instanceof FolderBusyError) {
        throw new NotStartedError(
          `${error.message}. Wait for it with wait_for_job (job_id ${error.job.id}), or give another out_dir.`,
          error.job.id,
        );
      }
      throw error;
    }
  }

  async wait(id: string, seconds: number, options: WaitOptions = {}): Promise<JobView | undefined> {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const { onLine, signal } = options;
    if (onLine) job.on('line', onLine);
    try {
      await job.wait(seconds * 1000, signal);
    } finally {
      if (onLine) job.off('line', onLine);
    }
    return viewJob(job);
  }

  async cancel(id: string): Promise<JobView | undefined> {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    await job.cancel();
    return viewJob(job);
  }

  async list(): Promise<JobView[]> {
    return this.jobs.list().reverse().map(viewJob);
  }

  setupReport({ version, enabled }: SetupOptions): string {
    return setupReport({ version, baseDir: this.baseDir, kits: this.kits, enabled });
  }

  close(): void {
    void this.jobs.closeAll();
  }
}

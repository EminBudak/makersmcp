import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
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
import { FolderBusyError, JobManager, type Job } from './jobs.js';
import { isInstalled, resolveKit, type InstalledKit, type KitDefinition, type MissingKit } from './kits.js';
import { setupReport } from './setup.js';

const MAX_FILES = 200;
// Entries looked at in one listing, so a folder that holds a whole project stays quick.
const MAX_ENTRIES = 20_000;
// Some file systems keep the time a file changed to the second, or to two.
const MTIME_SLACK_MS = 2000;
const MAX_DOC_CHARS = 40_000;
const HEAD_LINES = 5;
const TAIL_LINES = 30;

/** Never listed: hidden files and folders, like .git and a kit's .work- folders, and node_modules. */
function skipped(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules';
}

/**
 * The files in a folder, relative to it, at most MAX_FILES: a folder's own files in
 * name order before the files in its subfolders. With `since`, only the files changed
 * from then on, which for a job are the files it saved, whatever the folder held before.
 */
export function listFiles(folder: string, since?: number): JobFile[] {
  const files: JobFile[] = [];
  const queue = [folder];
  let seen = 0;
  while (queue.length && files.length < MAX_FILES && seen < MAX_ENTRIES) {
    const dir = queue.shift()!;
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
        stat = statSync(full);
      } catch {
        // Gone since the folder was read, like a lock file or a kit's work file.
        continue;
      }
      if (since !== undefined && stat.mtimeMs < since - MTIME_SLACK_MS) continue;
      files.push({ path: path.relative(folder, full), bytes: stat.size });
    }
  }
  return files;
}

/** The kit's notes in a folder, cut at MAX_DOC_CHARS each. */
export function readDocs(folder: string, names: string[] = []): JobDoc[] {
  const docs: JobDoc[] = [];
  for (const name of names) {
    const file = path.join(folder, name);
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      // Not there, or not a file.
      continue;
    }
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
      view.files = listFiles(spec.folder, job.startedAt);
      view.docs = readDocs(spec.folder, spec.docs);
    }
  }
  return view;
}

export interface LocalBackendOptions {
  /** Where kits save, and what relative paths are read from. A leading ~ is the home folder. */
  baseDir: string;
  /** A kit's folder to use instead of its installed package, like { musicfit: '../musicfit' }. */
  kitPaths?: Record<string, string>;
  /** The environment kits run with. Default: this process's. A service can keep its own secrets from them. */
  env?: NodeJS.ProcessEnv;
  /**
   * Refuse every file and folder outside baseDir, like an out_dir or a file elsewhere.
   * For a service that brings each job's inputs into the job's own baseDir.
   */
  confine?: boolean;
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
  private kits: Array<InstalledKit | MissingKit> = [];
  private readonly installed = new Map<string, InstalledKit>();

  constructor(options: LocalBackendOptions) {
    this.baseDir = path.resolve(expandHome(options.baseDir));
    this.kitPaths = options.kitPaths;
    this.env = options.env;
    this.confine = options.confine === true;
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

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ArgumentError, buildCommand } from './args.js';
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
const MAX_DOC_CHARS = 40_000;
const TAIL_LINES = 30;

/** The files in a folder, relative to it, in name order, at most MAX_FILES. */
export function listFiles(folder: string): JobFile[] {
  const files: JobFile[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= MAX_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push({ path: path.relative(folder, full), bytes: statSync(full).size });
    }
  };
  if (existsSync(folder)) walk(folder);
  return files;
}

/** The kit's notes in a folder, cut at MAX_DOC_CHARS each. */
export function readDocs(folder: string, names: string[] = []): JobDoc[] {
  const docs: JobDoc[] = [];
  for (const name of names) {
    const file = path.join(folder, name);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    docs.push(text.length > MAX_DOC_CHARS
      ? { name, text: text.slice(0, MAX_DOC_CHARS), more: file }
      : { name, text });
  }
  return docs;
}

function tail(text: string, lines = TAIL_LINES): string {
  return text.trim().split(/\r?\n/).slice(-lines).join('\n');
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
    ...(job.lastLine ? { lastLine: job.lastLine } : {}),
  };
  if (job.status === 'failed') {
    view.failure = [tail(job.stderr), tail(job.stdout, 10)].filter(Boolean).join('\n\n');
  }
  if (job.status === 'done') {
    // What the kit said at the end: its summary on stdout, or its last lines when it writes only to stderr.
    view.summary = job.stdout.trim() || tail(job.stderr, 12);
    if (spec.folder) {
      view.files = listFiles(spec.folder);
      view.docs = readDocs(spec.folder, spec.docs);
    }
  }
  return view;
}

export interface LocalBackendOptions {
  /** Where kits save, and what relative paths are read from. */
  baseDir: string;
  /** A kit's folder to use instead of its installed package, like { musicfit: '../musicfit' }. */
  kitPaths?: Record<string, string>;
}

/** Runs kits on this machine, each job a process of its own, saving into baseDir. */
export class LocalBackend implements KitBackend {
  readonly where = 'local';
  readonly place = 'on this machine';
  readonly baseDir: string;
  readonly jobs = new JobManager();
  private readonly kitPaths?: Record<string, string>;
  private kits: Array<InstalledKit | MissingKit> = [];
  private readonly installed = new Map<string, InstalledKit>();

  constructor(options: LocalBackendOptions) {
    this.baseDir = path.resolve(options.baseDir);
    this.kitPaths = options.kitPaths;
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
      command = buildCommand(tool, input, { baseDir: this.baseDir, installed: this.installed });
    } catch (error) {
      if (error instanceof ArgumentError) throw new NotStartedError(error.message);
      throw error;
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

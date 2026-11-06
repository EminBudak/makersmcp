import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type JobStatus = 'running' | 'done' | 'failed' | 'canceled';

export interface JobSpec {
  kit: string;
  tool: string;
  title: string;
  script: string;
  args: string[];
  cwd: string;
  folder?: string;
  docs?: string[];
  check?: boolean;
  /** For a check: what it writes once it has run, "stdout" or a file in the folder (ToolDefinition.report). */
  report?: string;
  /** The kit's environment. Default: this process's. With a launcher, what the launcher gets. */
  env?: NodeJS.ProcessEnv;
  /**
   * A command that starts the kit's supervisor in place of node, like
   * ['sudo', '-n', '-u', '<kit user>', '--', '<wrapper>', 'run'] for a kit that runs as
   * another user. It gets the kit's script and arguments after its own words, and has to
   * exec this package's dist/supervise.js with them in place of itself, so that its process
   * is the supervisor: the one whose stdin, exit status and process group are the job's.
   * No signal of this process reaches another user's, so a cancel ends that stdin instead,
   * and the supervisor stops the kit's group itself.
   */
  launcher?: string[];
  /**
   * Under confine: the folder the docs a job returns and the files it lists must be in,
   * whatever the kit left in its own folder (viewJob).
   */
  within?: string;
}

const STDOUT_LIMIT = 256 * 1024;
const STDERR_LIMIT = 64 * 1024;
const KEEP_FINISHED = 50;
const KILL_AFTER_MS = 5000;

// Every kit runs under this script, in a process group of its own: see supervise.ts.
const SUPERVISOR = fileURLToPath(new URL('./supervise.js', import.meta.url));

/** Why a launcher cannot start a supervisor, or nothing when it can. */
export function launcherProblem(launcher: unknown): string | undefined {
  if (Array.isArray(launcher) && launcher.length > 0 && launcher.every(word => typeof word === 'string' && word !== '')) {
    return undefined;
  }
  return 'A launcher is the command that starts the supervisor and its arguments, like ["sudo", "-n", "-u", "<kit user>", "--", "<wrapper>", "run"]';
}

/** Another job is writing to the same folder. */
export class FolderBusyError extends Error {
  constructor(readonly job: Job) {
    super(`${job.id} (${job.spec.tool}) is still writing to ${job.spec.folder}`);
  }
}

/** What a file is now, to tell whether a run wrote it: empty when it is not there. */
function stamp(file: string): string {
  try {
    const stat = statSync(file);
    return stat.isFile() ? `${stat.ino}:${stat.size}:${stat.mtimeMs}` : '';
  } catch {
    return '';
  }
}

/**
 * One run of a kit. It keeps the kit's output and its last line, which says
 * what the kit is doing now, and emits 'line' for each new one and 'end'.
 */
export class Job extends EventEmitter {
  status: JobStatus = 'running';
  exitCode: number | null = null;
  readonly startedAt = Date.now();
  endedAt?: number;
  stdout = '';
  stderr = '';
  lastLine = '';
  readonly finished: Promise<void>;
  private child?: ChildProcess;
  private canceling = false;
  private settle!: () => void;

  constructor(readonly id: string, readonly spec: JobSpec) {
    super();
    this.finished = new Promise(resolve => {
      this.settle = resolve;
    });
    const end = (status: JobStatus, exitCode: number | null) => this.end(status, exitCode);

    // A check's report as it was before the run, so one an earlier run left is not taken for this one's.
    const reportFile = spec.check && spec.report && spec.report !== 'stdout' && spec.folder
      ? path.join(spec.folder, spec.report)
      : undefined;
    const reportBefore = reportFile ? stamp(reportFile) : '';
    const checkRan = (): boolean => {
      if (!spec.report) return true;
      if (spec.report === 'stdout') return this.stdout.trim() !== '';
      if (!reportFile) return false;
      const now = stamp(reportFile);
      return now !== '' && now !== reportBefore;
    };

    if (spec.launcher !== undefined && launcherProblem(spec.launcher)) {
      this.stderr = `${launcherProblem(spec.launcher)}.`;
      end('failed', null);
      return;
    }
    // The supervisor, which node starts, or a launcher that becomes it.
    const [command, ...words] = spec.launcher
      ? [...spec.launcher, spec.script, ...spec.args]
      : [process.execPath, SUPERVISOR, spec.script, ...spec.args];

    try {
      this.child = spawn(command!, words, {
        cwd: spec.cwd,
        env: spec.env ?? process.env,
        // stdin stays open and unused: it closes when this process ends, however it ends,
        // or when a launcher's job is canceled, and the supervisor then stops the kit.
        stdio: ['pipe', 'pipe', 'pipe'],
        // Its own process group on POSIX, so a cancel also stops its Chrome and ffmpeg.
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      this.stderr = error instanceof Error ? error.message : String(error);
      end('failed', null);
      return;
    }

    this.child.stdin!.on('error', () => {
      // The supervisor is gone; it only ever reads the end of this pipe.
    });
    this.child.stdout!.setEncoding('utf8');
    this.child.stdout!.on('data', (chunk: string) => {
      if (this.stdout.length < STDOUT_LIMIT) this.stdout += chunk.slice(0, STDOUT_LIMIT - this.stdout.length);
      this.noteLine(chunk);
    });
    this.child.stderr!.setEncoding('utf8');
    this.child.stderr!.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_LIMIT);
      this.noteLine(chunk);
    });
    this.child.on('error', (error: NodeJS.ErrnoException) => {
      // spawn names the program when the folder it should start in is missing.
      this.note(error.code === 'ENOENT' && !existsSync(spec.cwd)
        ? `Cannot start the kit in ${spec.cwd}: that folder does not exist.`
        : error.message);
      end('failed', null);
    });
    this.child.on('close', (code, signal) => {
      if (this.canceling) return end('canceled', code);
      if (signal) this.note(`Stopped by ${signal}.`);
      if (code === 0) return end('done', code);
      if (code === 1 && spec.check) {
        if (checkRan()) return end('done', code);
        this.note(`The check could not run: the kit wrote ${spec.report === 'stdout' ? 'no report' : `no ${spec.report}`}.`);
      }
      end('failed', code);
    });
  }

  /**
   * The supervisor's process id, which on POSIX is also the process group of the kit and
   * of what it starts: the group a launcher's own clean-up keeps while the job runs.
   */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  get elapsedSeconds(): number {
    return Math.round(((this.endedAt ?? Date.now()) - this.startedAt) / 1000);
  }

  /** Waits up to ms for the job to end; true when it has. */
  wait(ms: number, signal?: AbortSignal): Promise<boolean> {
    if (this.status !== 'running') return Promise.resolve(true);
    return new Promise(resolve => {
      const finish = (ended: boolean) => {
        clearTimeout(timer);
        this.off('end', onEnd);
        signal?.removeEventListener('abort', onAbort);
        resolve(ended);
      };
      const onEnd = () => finish(true);
      const onAbort = () => finish(this.status !== 'running');
      const timer = setTimeout(() => finish(false), ms);
      this.once('end', onEnd);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Stops the kit and everything it started: SIGTERM, then SIGKILL after killAfterMs.
   * A launcher's kit may run as another user, whose processes no signal of this one
   * reaches, so its supervisor's stdin is ended instead, and the supervisor stops the
   * group. One still running after killAfterMs is given up on: the job ends as canceled,
   * with a note, and stopping what is left is the launcher's own clean-up.
   */
  cancel(killAfterMs = KILL_AFTER_MS): Promise<void> {
    if (this.status !== 'running') return this.finished;
    this.canceling = true;
    if (this.spec.launcher) {
      this.child?.stdin?.end();
      const timer = setTimeout(() => {
        this.note(`The kit had not stopped ${killAfterMs / 1000} s after the cancel, so stopping it is left to its launcher.`);
        this.end('canceled', null);
      }, killAfterMs);
      return this.finished.finally(() => clearTimeout(timer));
    }
    killTree(this.child, 'SIGTERM');
    const timer = setTimeout(() => killTree(this.child, 'SIGKILL'), killAfterMs);
    return this.finished.finally(() => clearTimeout(timer));
  }

  private end(status: JobStatus, exitCode: number | null): void {
    if (this.status !== 'running') return;
    this.status = status;
    this.exitCode = exitCode;
    this.endedAt = Date.now();
    this.settle();
    this.emit('end');
  }

  /** A line of makersmcp's own after what the kit said. */
  private note(line: string): void {
    this.stderr += `${this.stderr && !this.stderr.endsWith('\n') ? '\n' : ''}${line}\n`;
  }

  private noteLine(chunk: string): void {
    const line = chunk.split(/[\r\n]+/).map(part => part.trim()).filter(Boolean).pop();
    if (!line || line === this.lastLine) return;
    this.lastLine = line;
    this.emit('line', line);
  }
}

function killTree(child: ChildProcess | undefined, signal: NodeJS.Signals): void {
  if (!child?.pid || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

/**
 * The jobs of one makersmcp process. They end with it: closeAll stops them when the
 * client goes away, and each kit's supervisor stops it when this process is gone.
 */
export class JobManager {
  private readonly jobs = new Map<string, Job>();

  start(spec: JobSpec): Job {
    if (spec.folder) {
      const busy = this.list().find(job => job.status === 'running' && job.spec.folder === spec.folder);
      if (busy) throw new FolderBusyError(busy);
    }
    const job = new Job(`job_${randomBytes(4).toString('hex')}`, spec);
    this.jobs.set(job.id, job);
    this.prune();
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(): Job[] {
    return [...this.jobs.values()];
  }

  /** Stops every running job, when the client goes away. Resolves once they have all ended, or a launcher's were given up on. */
  closeAll(killAfterMs = KILL_AFTER_MS): Promise<void> {
    const running = this.list().filter(job => job.status === 'running');
    return Promise.all(running.map(job => job.cancel(killAfterMs))).then(() => undefined);
  }

  private prune(): void {
    const finished = this.list().filter(job => job.status !== 'running');
    for (const job of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) {
      this.jobs.delete(job.id);
    }
  }
}

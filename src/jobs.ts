import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
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
}

const STDOUT_LIMIT = 256 * 1024;
const STDERR_LIMIT = 64 * 1024;
const KEEP_FINISHED = 50;
const KILL_AFTER_MS = 5000;

// Every kit runs under this script, in a process group of its own: see supervise.ts.
const SUPERVISOR = fileURLToPath(new URL('./supervise.js', import.meta.url));

/** Another job is writing to the same folder. */
export class FolderBusyError extends Error {
  constructor(readonly job: Job) {
    super(`${job.id} (${job.spec.tool}) is still writing to ${job.spec.folder}`);
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

  constructor(readonly id: string, readonly spec: JobSpec) {
    super();
    let settle!: () => void;
    this.finished = new Promise(resolve => {
      settle = resolve;
    });
    const end = (status: JobStatus, exitCode: number | null) => {
      if (this.status !== 'running') return;
      this.status = status;
      this.exitCode = exitCode;
      this.endedAt = Date.now();
      settle();
      this.emit('end');
    };

    try {
      this.child = spawn(process.execPath, [SUPERVISOR, spec.script, ...spec.args], {
        cwd: spec.cwd,
        env: process.env,
        // stdin stays open and unused: it closes when this process ends, however it ends,
        // and the supervisor then stops the kit.
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
      const passed = code === 0 || (code === 1 && spec.check === true);
      end(passed ? 'done' : 'failed', code);
    });
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

  /** Stops the kit and everything it started: SIGTERM, then SIGKILL after killAfterMs. */
  cancel(killAfterMs = KILL_AFTER_MS): Promise<void> {
    if (this.status !== 'running') return this.finished;
    this.canceling = true;
    killTree(this.child, 'SIGTERM');
    const timer = setTimeout(() => killTree(this.child, 'SIGKILL'), killAfterMs);
    return this.finished.finally(() => clearTimeout(timer));
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

  /** Stops every running job, when the client goes away. Resolves once they have all ended. */
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

import type { KitDefinition, ToolDefinition } from './kits.js';

// Where kit jobs run. createMcpServer registers the same tools either way: with the
// LocalBackend (the default) the kits run on this machine and save into its folders;
// a hosted service implements KitBackend to run them on its own machines and hand
// back links to the files.

export type JobStatus = 'running' | 'done' | 'failed' | 'canceled';

/** A file a job saved. */
export interface JobFile {
  /** Relative to the job's folder. */
  path: string;
  bytes: number;
  /** A hosted job's file: where to download it, until JobView.expiresAt. */
  url?: string;
}

/** A note a kit writes for the agent, like BRAND.md, read once the job is done. */
export interface JobDoc {
  name: string;
  text: string;
  /** Set when the text was cut: where the rest is. */
  more?: string;
}

/** A job as the tools show it, wherever it runs. */
export interface JobView {
  id: string;
  kit: string;
  tool: string;
  title: string;
  status: JobStatus;
  /** A check tool: its exit code 1 means the check failed, not the job. */
  check?: boolean;
  exitCode: number | null;
  elapsedSeconds: number;
  /** Where the files are: a folder on this machine, or a hosted job's name for it. */
  folder?: string;
  /** What the kit was doing last. */
  lastLine?: string;
  /** Once done: what the kit said at the end. */
  summary?: string;
  /** Once failed: the tail of what the kit printed. */
  failure?: string;
  /** Once done: the files it saved, and the kit's notes among them. */
  files?: JobFile[];
  docs?: JobDoc[];
  /** A hosted job: when its files and links go away, in unix seconds. */
  expiresAt?: number;
}

/** A kit the backend can run, at the version it runs. */
export interface AvailableKit {
  definition: KitDefinition;
  version: string;
}

/** A kit the backend cannot run, and why. */
export interface UnavailableKit {
  definition: KitDefinition;
  reason: string;
}

export interface StartRequest {
  kit: AvailableKit;
  tool: ToolDefinition;
  /** The tool's arguments as the client sent them, without wait_seconds. */
  input: Record<string, unknown>;
}

export interface WaitOptions {
  signal?: AbortSignal;
  /** Called with each new progress line while waiting. */
  onLine?: (line: string) => void;
}

/** Thrown by start when a job cannot start, with a message for the agent. */
export class NotStartedError extends Error {
  /** The running job that blocks this one, when that is the reason. */
  readonly jobId?: string;

  constructor(message: string, jobId?: string) {
    super(message);
    this.name = 'NotStartedError';
    this.jobId = jobId;
  }
}

/** What check_setup knows when it asks a backend for its report. */
export interface SetupOptions {
  /** makersmcp's version. */
  version: string;
  /** The kits this server turned on. */
  enabled: Set<string>;
}

export interface KitBackend {
  /** local: kits run on this machine and take paths on it. hosted: kits run on a service and take links. */
  readonly where: 'local' | 'hosted';
  /** Where jobs run, for tool descriptions, like "on makersmcp.com". */
  readonly place?: string;
  /** For each definition, the kit as it runs here, or why it cannot. */
  available(definitions: KitDefinition[]): Array<AvailableKit | UnavailableKit>;
  start(request: StartRequest): Promise<JobView>;
  /** Waits until the job ends or `seconds` pass. Undefined when there is no such job. */
  wait(id: string, seconds: number, options?: WaitOptions): Promise<JobView | undefined>;
  cancel(id: string): Promise<JobView | undefined>;
  /** Its jobs, newest first. */
  list(): Promise<JobView[]>;
  /** What check_setup answers. */
  setupReport(options: SetupOptions): string | Promise<string>;
  /** Called when the MCP connection closes. LocalBackend stops its jobs; a hosted one may keep them. */
  close(): void;
}

export function isAvailable(kit: AvailableKit | UnavailableKit): kit is AvailableKit {
  return 'version' in kit;
}

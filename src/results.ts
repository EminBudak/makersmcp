import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Job } from './jobs.js';

const MAX_FILES = 200;
const MAX_LISTED = 40;
const MAX_DOC_CHARS = 40_000;
const TAIL_LINES = 30;

export interface FileEntry {
  path: string;
  bytes: number;
}

export const jobOutputSchema = {
  job_id: z.string(),
  kit: z.string(),
  tool: z.string(),
  status: z.enum(['running', 'done', 'failed', 'canceled']),
  passed: z.boolean().optional().describe('For checks: whether the check passed.'),
  exit_code: z.number().int().nullable().optional(),
  elapsed_seconds: z.number(),
  folder: z.string().optional().describe('Where the kit saved its files.'),
  files: z.array(z.object({ path: z.string(), bytes: z.number() })).optional(),
  last_line: z.string().optional().describe('What the kit was doing last.'),
  next_action: z.object({
    tool: z.string(),
    arguments: z.record(z.string(), z.unknown()),
  }).optional(),
};

/** The files in a folder, relative to it, in name order, at most MAX_FILES. */
export function listFiles(folder: string): FileEntry[] {
  const files: FileEntry[] = [];
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

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function tail(text: string, lines = TAIL_LINES): string {
  return text.trim().split(/\r?\n/).slice(-lines).join('\n');
}

/** What the kit said at the end: its summary on stdout, or its last lines when it writes only to stderr. */
function summary(job: Job): string {
  return job.stdout.trim() || tail(job.stderr, 12);
}

export function jobStructured(job: Job, files?: FileEntry[]) {
  return {
    job_id: job.id,
    kit: job.spec.kit,
    tool: job.spec.tool,
    status: job.status,
    ...(job.spec.check && job.status === 'done' ? { passed: job.exitCode === 0 } : {}),
    exit_code: job.exitCode,
    elapsed_seconds: job.elapsedSeconds,
    ...(job.spec.folder ? { folder: job.spec.folder } : {}),
    ...(files ? { files } : {}),
    ...(job.lastLine ? { last_line: job.lastLine } : {}),
    ...(job.status === 'running'
      ? { next_action: { tool: 'wait_for_job', arguments: { job_id: job.id } } }
      : {}),
  };
}

/** The tool result for a job in any state. */
export function jobResult(job: Job): CallToolResult {
  const { spec } = job;
  const seconds = `${job.elapsedSeconds} s`;

  if (job.status === 'running') {
    return {
      content: [{
        type: 'text',
        text: `## ${spec.title}: still running after ${seconds}\n\n`
          + (job.lastLine ? `Last step: ${job.lastLine}\n\n` : '')
          + `Job ID: ${job.id}\n\n`
          + `Call wait_for_job with this job_id to keep waiting. Do not call ${spec.tool} again for the same thing: that starts a second job.`,
      }],
      structuredContent: jobStructured(job),
    };
  }

  if (job.status === 'canceled') {
    return {
      content: [{ type: 'text', text: `## ${spec.title}: canceled after ${seconds}\n\nJob ID: ${job.id}` }],
      structuredContent: jobStructured(job),
    };
  }

  if (job.status === 'failed') {
    const said = [tail(job.stderr), tail(job.stdout, 10)].filter(Boolean).join('\n\n');
    return {
      content: [{
        type: 'text',
        text: `## ${spec.title}: failed after ${seconds}`
          + (job.exitCode !== null ? ` (exit code ${job.exitCode})` : '')
          + `\n\n${said || 'The kit said nothing.'}\n\nJob ID: ${job.id}`,
      }],
      structuredContent: jobStructured(job),
      isError: true,
    };
  }

  const files = spec.folder ? listFiles(spec.folder) : undefined;
  const heading = spec.check
    ? `## ${spec.title}: ${job.exitCode === 0 ? 'passed' : 'failed the check'} (${seconds})`
    : `## ${spec.title}: done in ${seconds}`;
  const parts = [heading, summary(job)];

  if (spec.folder && files) {
    const listed = files.slice(0, MAX_LISTED).map(file => `- ${file.path} (${size(file.bytes)})`);
    if (files.length > MAX_LISTED) listed.push(`- and ${files.length - MAX_LISTED} more`);
    parts.push(`Folder: ${spec.folder}\n\n${listed.join('\n') || 'No files.'}`);
  }

  for (const doc of spec.docs ?? []) {
    const file = spec.folder ? path.join(spec.folder, doc) : undefined;
    if (!file || !existsSync(file)) continue;
    let text = readFileSync(file, 'utf8');
    if (text.length > MAX_DOC_CHARS) text = `${text.slice(0, MAX_DOC_CHARS)}\n\n(cut here: read ${file} for the rest)`;
    parts.push(`### ${doc}\n\n${text.trim()}`);
  }

  return {
    content: [{ type: 'text', text: parts.filter(Boolean).join('\n\n') }],
    structuredContent: jobStructured(job, files),
  };
}

export function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

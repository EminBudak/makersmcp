import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { JobView } from './backend.js';

const MAX_LISTED = 40;

export const jobOutputSchema = {
  job_id: z.string(),
  kit: z.string(),
  tool: z.string(),
  status: z.enum(['running', 'done', 'failed', 'canceled']),
  passed: z.boolean().optional().describe('For checks: whether the check passed.'),
  exit_code: z.number().int().nullable().optional(),
  elapsed_seconds: z.number(),
  folder: z.string().optional().describe('Where the kit saved its files.'),
  files: z.array(z.object({
    path: z.string(),
    bytes: z.number(),
    url: z.string().optional().describe('Where to download the file, when the job ran on a server.'),
  })).optional(),
  expires_at: z.string().optional().describe('When the download links stop working.'),
  last_line: z.string().optional().describe('What the kit was doing last.'),
  next_action: z.object({
    tool: z.string(),
    arguments: z.record(z.string(), z.unknown()),
  }).optional(),
};

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function until(expiresAt: number): string {
  return `${new Date(expiresAt * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function jobStructured(view: JobView) {
  return {
    job_id: view.id,
    kit: view.kit,
    tool: view.tool,
    status: view.status,
    ...(view.check && view.status === 'done' ? { passed: view.exitCode === 0 } : {}),
    exit_code: view.exitCode,
    elapsed_seconds: view.elapsedSeconds,
    ...(view.folder ? { folder: view.folder } : {}),
    ...(view.files ? { files: view.files } : {}),
    ...(view.files && view.expiresAt ? { expires_at: new Date(view.expiresAt * 1000).toISOString() } : {}),
    ...(view.lastLine ? { last_line: view.lastLine } : {}),
    ...(view.status === 'running'
      ? { next_action: { tool: 'wait_for_job', arguments: { job_id: view.id } } }
      : {}),
  };
}

/** The tool result for a job in any state. */
export function jobResult(view: JobView): CallToolResult {
  const seconds = `${view.elapsedSeconds} s`;

  if (view.status === 'running') {
    return {
      content: [{
        type: 'text',
        text: `## ${view.title}: still running after ${seconds}\n\n`
          + (view.lastLine ? `Last step: ${view.lastLine}\n\n` : '')
          + `Job ID: ${view.id}\n\n`
          + `Call wait_for_job with this job_id to keep waiting. Do not call ${view.tool} again for the same thing: that starts a second job.`,
      }],
      structuredContent: jobStructured(view),
    };
  }

  if (view.status === 'canceled') {
    return {
      content: [{ type: 'text', text: `## ${view.title}: canceled after ${seconds}\n\nJob ID: ${view.id}` }],
      structuredContent: jobStructured(view),
    };
  }

  if (view.status === 'failed') {
    return {
      content: [{
        type: 'text',
        text: `## ${view.title}: failed after ${seconds}`
          + (view.exitCode !== null ? ` (exit code ${view.exitCode})` : '')
          + `\n\n${view.failure || 'The kit said nothing.'}\n\nJob ID: ${view.id}`,
      }],
      structuredContent: jobStructured(view),
      isError: true,
    };
  }

  const heading = view.check
    ? `## ${view.title}: ${view.exitCode === 0 ? 'passed' : 'failed the check'} (${seconds})`
    : `## ${view.title}: done in ${seconds}`;
  const parts = [heading, view.summary ?? ''];

  if (view.files) {
    const listed = view.files.slice(0, MAX_LISTED)
      .map(file => `- ${file.path} (${size(file.bytes)})${file.url ? `: ${file.url}` : ''}`);
    if (view.files.length > MAX_LISTED) listed.push(`- and ${view.files.length - MAX_LISTED} more`);
    const where = view.files.some(file => file.url)
      ? `Files${view.expiresAt ? `, to download until ${until(view.expiresAt)}` : ''}:`
      : `Folder: ${view.folder}`;
    parts.push(`${where}\n\n${listed.join('\n') || 'No files.'}`);
  }

  for (const doc of view.docs ?? []) {
    parts.push(`### ${doc.name}\n\n${doc.text.trim()}`
      + (doc.more ? `\n\n(cut here: read ${doc.more} for the rest)` : ''));
  }

  return {
    content: [{ type: 'text', text: parts.filter(Boolean).join('\n\n') }],
    structuredContent: jobStructured(view),
  };
}

export function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { clearSession, configMtimeMs, configPath, loadSession, type SessionConfig } from './config.js';
import { LinkedInHttpClient } from './http-client.js';
import { DATE_POSTED, EXPERIENCE, JOB_TYPE, LinkedInJobs, SORT, WORK_TYPE } from './linkedin.js';
import { JobWatcher } from './watch.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const loginScriptPath = join(__dirname, '..', 'scripts', 'browser-login.mjs');

// `npm run login` writes the session from another process: pick up a newer
// config file without restarting the MCP client (same as familysearch-mcp).
let session: SessionConfig = loadSession();
let sessionMtime = configMtimeMs();
function currentCookies(): string {
  const mtime = configMtimeMs();
  if (mtime !== sessionMtime) {
    sessionMtime = mtime;
    session = loadSession();
  }
  return session.cookies;
}

const http = new LinkedInHttpClient({ getCookies: currentCookies });
const jobs = new LinkedInJobs(http);
const watcher = new JobWatcher(jobs);
const server = new McpServer({ name: 'linkedin-jobs', version: '0.1.0' });

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});
// Errors never include cookies: they are built from status codes and paths only.
async function run(fn: () => Promise<unknown> | unknown) {
  try {
    return text(await fn());
  } catch (error) {
    return { isError: true, ...text(error instanceof Error ? error.message : String(error)) };
  }
}

const csvOf = (keys: readonly string[], label: string) =>
  z
    .string()
    .regex(new RegExp(`^(${keys.join('|')})(,(${keys.join('|')}))*$`), `Comma-separated: ${keys.join(', ')}`)
    .optional()
    .describe(`${label}, comma-separated (${keys.join(', ')})`);

const filters = {
  location: z.string().max(100).optional().describe("e.g. 'Brazil', 'Netherlands', 'Berlin, Germany'"),
  jobType: csvOf(Object.keys(JOB_TYPE), 'Job type'),
  experienceLevel: csvOf(Object.keys(EXPERIENCE), 'Experience level'),
  workType: csvOf(Object.keys(WORK_TYPE), 'Work type'),
  easyApply: z.boolean().optional().describe('Only Easy Apply jobs'),
};

// ── Session (pattern from familysearch-mcp) ───────────────────────────────────

server.tool(
  'login-with-browser',
  'Open your Brave/Chrome to log in to LinkedIn by hand and save the session locally (~/.linkedin-jobs-mcp). The password never goes through the AI.',
  {},
  () =>
    run(async () => {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [loginScriptPath], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (c) => (stderr += c.toString()));
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `Login exited with code ${code}`))));
      });
      currentCookies();
      if (!http.hasSession()) throw new Error('Browser login did not save a LinkedIn session.');
      return `Logged in as ${session.userName}. Session saved to ${configPath}.`;
    }),
);

server.tool('session-status', 'Show whether a LinkedIn session is saved, and any active rate-limit pause.', {}, () =>
  run(() => {
    currentCookies();
    return {
      loggedIn: http.hasSession(),
      user: session.userName || undefined,
      savedAt: session.savedAt || undefined,
      pausedForSeconds: http.cooldownRemainingSeconds(),
      requestsThisRun: http.requestCount,
    };
  }),
);

server.tool('logout', 'Delete the saved LinkedIn session cookies from this machine.', {}, () =>
  run(() => {
    clearSession();
    session = loadSession();
    sessionMtime = configMtimeMs();
    return 'Session deleted. The separate browser profile in ~/.linkedin-jobs-mcp/browser-profile still remembers the login; delete that folder to forget it completely.';
  }),
);

// ── Jobs (functions from linkedin-mcp-server) ─────────────────────────────────

server.tool(
  'search-jobs',
  'Search LinkedIn jobs. Returns job ids for get-job-details. Public endpoint, no cookies sent.',
  {
    keywords: z.string().min(1).max(200),
    ...filters,
    datePosted: z.enum(Object.keys(DATE_POSTED) as [keyof typeof DATE_POSTED]).optional(),
    sortBy: z.enum(Object.keys(SORT) as [keyof typeof SORT]).optional(),
    maxPages: z.number().int().min(1).max(10).optional().describe('Pages of ~10 results (default 1). Each page is one request, ~4 s apart.'),
  },
  (args) => run(() => jobs.search(args)),
);

server.tool(
  'get-job-details',
  'Full posting: description, criteria, applicants, visaMentions (visa/relocation phrases in the ad; empty = not stated) and visaNegatives. When logged in, adds exact publish time, applicant count and whether you already applied.',
  { jobId: z.string().regex(/^\d{6,15}$/, 'Numeric LinkedIn job id').describe('Job id from search-jobs or fresh-jobs') },
  ({ jobId }) => run(() => jobs.details(jobId)),
);

// ── Fresh jobs & saved searches (Davi) ─────────────────────────────────────────

server.tool(
  'fresh-jobs',
  'Jobs posted in the last N minutes, newest first, for one or more keyword sets at once. Each job is flagged isNew if this server never returned it before.',
  {
    keywords: z.array(z.string().min(1).max(200)).min(1).max(5).describe("e.g. ['full stack', 'react developer']"),
    withinMinutes: z.number().int().min(5).max(10080).default(60).describe('Time window (default 60 = last hour)'),
    ...filters,
    onlyNew: z.boolean().optional().describe('Hide jobs already returned in earlier calls'),
    maxPages: z.number().int().min(1).max(5).optional().describe('Pages per keyword (default 2)'),
  },
  (args) => run(() => watcher.fresh(args)),
);

server.tool(
  'save-search',
  'Save a search by name so check-saved-searches can report only new jobs. Same name replaces it.',
  { name: z.string().min(1).max(60), keywords: z.string().min(1).max(200), ...filters },
  (args) => run(() => watcher.saveSearch(args)),
);

server.tool('list-saved-searches', 'List saved searches and when each was last checked.', {}, () => run(() => watcher.list()));

server.tool('delete-saved-search', 'Delete a saved search by name.', { name: z.string().min(1).max(60) }, ({ name }) =>
  run(() => watcher.delete(name)),
);

server.tool(
  'check-saved-searches',
  'Run saved searches over the time since each was last checked and return only jobs never seen before.',
  { names: z.array(z.string().max(60)).max(30).optional().describe('Subset by name; default all') },
  ({ names }) => run(() => watcher.checkSaved(names)),
);

await server.connect(new StdioServerTransport());

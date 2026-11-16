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
import { fetchOwnProfile, importFromText } from './profile-import.js';
import { LANG_LEVELS, SENIORITY, analyzeFit, clearProfile, loadProfile, profileExcludes, profilePath, saveProfile, type Profile } from './profile.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const loginScriptPath = join(__dirname, '..', 'scripts', 'browser-login.mjs');

// `npm run login` writes the session from another process: pick up a newer
// config file without restarting the MCP client (same as familysearch-mcp).
// `npx github:G4rutti/linkedin-jobs-mcp --login` runs the browser login and exits.
if (process.argv.includes('--login')) {
  const child = spawn(process.execPath, [loginScriptPath], { stdio: 'inherit' });
  child.on('close', (code) => process.exit(code ?? 1));
  await new Promise(() => {});
}

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
const jobs = new LinkedInJobs(http, () => profileExcludes(loadProfile()));
const watcher = new JobWatcher(jobs);
const server = new McpServer({ name: 'linkedin-jobs', version: '0.3.0' });

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
  under10Applicants: z.boolean().optional().describe("LinkedIn's 'Under 10 applicants' filter: apply while you are still early"),
  excludeTitle: z
    .array(z.string().min(1).max(40))
    .max(20)
    .optional()
    .describe("Drop jobs whose title contains any of these words (whole words). Omit to use the words derived from your profile (set-profile); pass [] to turn title filtering off. Backs up NOT, which LinkedIn ignores in complex queries."),
};

const KEYWORDS_HELP =
  'LinkedIn Boolean: AND / OR / NOT in uppercase, "straight quotes" for exact phrases, (parentheses) to group. Precedence: quotes > () > NOT > AND > OR, so wrap OR lists in (). No wildcards (*) or +/-. Curly quotes and lowercase operators are fixed automatically and reported in warnings. Visa tip: ("visa sponsorship" OR "relocation"), never bare "sponsorship".';

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
    keywords: z.string().min(1).max(200).describe(KEYWORDS_HELP),
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
  ({ jobId }) =>
    run(async () => {
      const job = await jobs.details(jobId);
      const profile = loadProfile();
      return profile ? { ...job, fit: analyzeFit(job, profile) } : job;
    }),
);

// ── Profile: who is searching (any user) ──────────────────────────────────────

server.tool(
  'set-profile',
  'Save who you are once (seniority, years, skills, languages, visa need). Then searches drop titles out of your reach and get-job-details / triage-jobs add a fit check. Fields you omit keep their current value. Stored only on this machine.',
  {
    seniority: z.enum(SENIORITY).optional().describe('intern | junior | mid | senior | lead. Drives which title words are dropped.'),
    yearsExperience: z.number().min(0).max(50).optional(),
    skills: z.array(z.string().min(1).max(40)).max(60).optional().describe("e.g. ['React','TypeScript','Node.js','Python']"),
    languages: z
      .record(z.string().regex(/^[a-z]{2}$/, 'ISO 639-1 code like en, de, nl, pt'), z.enum(LANG_LEVELS))
      .optional()
      .describe("ISO code -> level (none, A1..C2, native), e.g. { en: 'C1', pt: 'native', de: 'none' }"),
    needsVisa: z.boolean().optional().describe('true if you need sponsorship to work where you are searching'),
    excludeTitle: z.array(z.string().min(1).max(40)).max(30).optional().describe('Extra title words to always drop'),
    includeTitle: z.array(z.string().min(1).max(40)).max(30).optional().describe("Words to keep even if your seniority would drop them, e.g. ['medior']"),
  },
  (args) =>
    run(() => {
      const merged: Profile = { ...(loadProfile() ?? {}), ...Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined)) };
      saveProfile(merged);
      return { saved: merged, droppedTitleWords: profileExcludes(merged) ?? [], file: profilePath };
    }),
);

server.tool(
  'import-profile',
  "Fill your profile from the real thing instead of typing it. Without `text`: reads YOUR OWN LinkedIn profile (jobs with dates, skills, languages) through the saved login session; it can only read the account that owns the session. With `text`: parses a CV or LinkedIn 'Save to PDF' text you paste (works without login and does not depend on LinkedIn's internal API). Fills seniority, yearsExperience, skills and languages; never needsVisa (a profile cannot know it: use set-profile). Saves by default and returns what it understood, so fix anything wrong with set-profile.",
  {
    text: z.string().min(40).max(60000).optional().describe('CV or LinkedIn profile text. Omit to read your own LinkedIn profile through the session.'),
    save: z.boolean().default(true).describe('false = only preview what would be saved'),
    debug: z.boolean().optional().describe('Include per-step diagnostics (response entity types) of the LinkedIn read'),
  },
  ({ text, save, debug }) =>
    run(async () => {
      const d = new Date();
      const now = { y: d.getFullYear(), m: d.getMonth() + 1 };
      let imported;
      let diagnostics;
      if (text) imported = importFromText(text, now);
      else {
        currentCookies();
        if (!http.hasSession()) throw new Error('Not logged in. Run login-with-browser, or pass `text` with your CV.');
        const res = await fetchOwnProfile(http, now);
        imported = res.imported;
        diagnostics = res.diagnostics;
      }
      const found = imported.profile;
      if (found.yearsExperience === undefined && !found.skills?.length && !Object.keys(found.languages ?? {}).length) {
        return {
          saved: false,
          error: 'Nothing usable was found in the source. LinkedIn may have changed its internal API; pass `text` (CV or Save to PDF) instead.',
          notes: imported.notes,
          diagnostics,
        };
      }
      const current = loadProfile() ?? {};
      const merged: Profile = {
        ...current,
        ...Object.fromEntries(Object.entries(found).filter(([k, v]) => k !== 'languages' && v !== undefined)),
        ...(found.languages ? { languages: { ...(current.languages ?? {}), ...found.languages } } : {}),
      };
      if (save) saveProfile(merged);
      return {
        saved: save,
        imported: found,
        positions: imported.positions,
        notes: imported.notes,
        needsVisa: merged.needsVisa ?? 'not set: use set-profile if you need sponsorship',
        droppedTitleWords: profileExcludes(merged) ?? [],
        ...(debug || !(found.yearsExperience !== undefined && found.skills?.length) ? { diagnostics } : {}),
      };
    }),
);

server.tool('get-profile', 'Show the saved profile and the title words it drops from searches.', {}, () =>
  run(() => {
    const p = loadProfile();
    return p ? { profile: p, droppedTitleWords: profileExcludes(p) ?? [] } : 'No profile yet. Use set-profile.';
  }),
);

server.tool('clear-profile', 'Delete the saved profile.', {}, () => run(() => (clearProfile() ? 'Profile deleted.' : 'There was no profile.')));

server.tool(
  'triage-jobs',
  'Open several postings and rank them against your profile: good, stretch, unknown, blocked, with the reasons (years asked, languages, visa, stack overlap). Use it on ids from search-jobs or fresh-jobs before reading descriptions one by one.',
  { jobIds: z.array(z.string().regex(/^\d{6,15}$/)).min(1).max(10) },
  ({ jobIds }) =>
    run(async () => {
      const profile = loadProfile();
      if (!profile) throw new Error('No profile yet. Call set-profile first.');
      const order = { good: 0, stretch: 1, unknown: 2, blocked: 3 } as const;
      const rows = [];
      const errors: string[] = [];
      for (const id of [...new Set(jobIds)]) {
        try {
          const job = await jobs.details(id);
          const fit = analyzeFit(job, profile);
          rows.push({
            id,
            title: job.title,
            company: job.company,
            location: job.location,
            applicants: job.applicants,
            closed: job.closed,
            verdict: fit.verdict,
            blockers: fit.blockers,
            stretches: fit.stretches,
            pluses: fit.pluses,
            url: job.url,
          });
        } catch (error) {
          if (error instanceof Error && error.name === 'RateLimitError') throw error;
          errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      rows.sort((a, b) => order[a.verdict] - order[b.verdict] || Number(a.closed) - Number(b.closed));
      return { ranked: rows, ...(errors.length ? { errors } : {}) };
    }),
);

// ── Fresh jobs & saved searches (Davi) ─────────────────────────────────────────

server.tool(
  'fresh-jobs',
  'Jobs posted in the last N minutes, newest first, for one or more keyword sets at once. Each job is flagged isNew if this server never returned it before.',
  {
    keywords: z.array(z.string().min(1).max(200)).min(1).max(5).describe(`One query per item, e.g. ['full stack', 'react developer']. ${KEYWORDS_HELP}`),
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
  { name: z.string().min(1).max(60), keywords: z.string().min(1).max(200).describe(KEYWORDS_HELP), ...filters },
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

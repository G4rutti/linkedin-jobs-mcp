#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { clearSession, configMtimeMs, configPath, extrasCachePath, jobCachePath, jsonFileStore, loadRuntime, loadSession, saveRuntime, type SessionConfig } from './config.js';
import { TtlCache } from './cache.js';
import { LinkedInHttpClient } from './http-client.js';
import { DATE_POSTED, DETAILS_TTL_MS, EXPERIENCE, EXTRAS_TTL_MS, JOB_TYPE, LinkedInJobs, SORT, WORK_TYPE, type JobDetails } from './linkedin.js';
import { JobWatcher } from './watch.js';
import { fetchOwnProfile, importFromText } from './profile-import.js';
import { COMPANY_SECTIONS, PERSON_SECTIONS, companyFrom, fetchCompany, fetchPerson, usernameFrom } from './person.js';
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

const http = new LinkedInHttpClient({ getCookies: currentCookies, loadRuntime, saveRuntime });
// Job details and logged-in extras are cached on disk, so a restart does not refetch them.
const jobs = new LinkedInJobs(http, () => profileExcludes(loadProfile()), {
  details: new TtlCache<JobDetails>(DETAILS_TTL_MS, 300, Date.now, jsonFileStore<JobDetails>(jobCachePath)),
  extras: new TtlCache<Record<string, unknown>>(EXTRAS_TTL_MS, 300, Date.now, jsonFileStore<Record<string, unknown>>(extrasCachePath)),
});
const watcher = new JobWatcher(jobs);
const server = new McpServer({ name: 'linkedin-jobs', version: '0.5.1' });

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

server.tool('session-status', 'Show whether a LinkedIn session is saved, any active rate-limit pause, the last block (which endpoint, with or without your session) and cache usage. Makes no request.', {}, () =>
  run(() => {
    currentCookies();
    return {
      loggedIn: http.hasSession(),
      user: session.userName || undefined,
      savedAt: session.savedAt || undefined,
      pausedForSeconds: http.cooldownRemainingSeconds(),
      // withSession=false means LinkedIn blocked the public endpoint by IP, not your account.
      lastBlock: http.lastBlock,
      requestsThisRun: http.requestCount,
      cache: {
        searchPages: jobs.caches.search.stats(),
        jobDetails: jobs.caches.details.stats(),
        loggedInExtras: jobs.caches.extras.stats(),
      },
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
    maxPages: z.number().int().min(1).max(10).optional().describe('Pages of ~10 results (default 1). Each page is one request, ~4 s apart; paging stops early on a short page, and repeats within 5 min come from cache.'),
  },
  (args) => run(() => jobs.search(args)),
);

server.tool(
  'get-job-details',
  'Full posting: description, criteria, applicants, visaMentions (visa/relocation phrases in the ad; empty = not stated) and visaNegatives. The logged-in extras (exact publish time, applicant count, already applied) are off by default because they call the LinkedIn internal API with your cookie; set LINKEDIN_EXTRAS=1 to enable them. Cached: the posting for 6 h, the logged-in extras for 1 h (see cachedAt).',
  {
    jobId: z.string().regex(/^\d{6,15}$/, 'Numeric LinkedIn job id').describe('Job id from search-jobs or fresh-jobs'),
    refresh: z.boolean().optional().describe('Ignore the cache and fetch again (costs requests)'),
  },
  ({ jobId, refresh }) =>
    run(async () => {
      const job = await jobs.details(jobId, { refresh });
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

server.tool(
  'get-person-profile',
  "Read a LinkedIn profile by sections, through your saved login. The main block (name, headline, location, followers, connections, about, photo, skills, certifications) always comes back; ask only for the sections you need: experience, education, contact_info, interests, honors, languages, posts, recommendations. Without `username` it reads YOUR OWN profile. With a username it reads that public profile as seen by your account (contact info only if you are connected). Each section fails on its own: a failure shows up under `errors` and the rest still returns.",
  {
    username: z.string().max(200).optional().describe('Part after /in/ (or the full profile URL). Omit for your own profile.'),
    sections: z.array(z.enum(PERSON_SECTIONS)).default([...PERSON_SECTIONS].filter((s) => s !== 'posts')).describe(`Sections to fetch (${PERSON_SECTIONS.join(', ')}). Default: all except posts.`),
    postsLimit: z.number().int().min(1).max(20).default(5),
  },
  ({ username, sections, postsLimit }) =>
    run(async () => {
      currentCookies();
      if (!http.hasSession()) throw new Error('Not logged in. Run login-with-browser first.');
      const d = new Date();
      return fetchPerson(http, { username: username ? usernameFrom(username) : undefined, sections, postsLimit }, { y: d.getFullYear(), m: d.getMonth() + 1 });
    }),
);

server.tool(
  'get-company-profile',
  'Read a LinkedIn company page. The about block (overview, website, industry, size, headquarters, specialties, followers, logo) always comes back; sections: posts (recent feed posts with reactions/comments), jobs (open positions).',
  {
    company: z.string().min(1).max(200).describe('Part after /company/ (e.g. "epharma") or the full company URL.'),
    sections: z.array(z.enum(COMPANY_SECTIONS)).default([]),
    limit: z.number().int().min(1).max(20).default(5),
  },
  ({ company, sections, limit }) =>
    run(async () => {
      currentCookies();
      if (!http.hasSession()) throw new Error('Not logged in. Run login-with-browser first.');
      return fetchCompany(http, { company: companyFrom(company), sections, limit });
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
  'Open several postings and rank them against your profile: good, stretch, unknown, blocked, with the reasons (years asked, languages, visa, stack overlap). Use it on ids from search-jobs or fresh-jobs before reading descriptions one by one. One public request per job not already cached; it skips the logged-in extras, which the ranking does not use.',
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
          const job = await jobs.details(id, { extras: false });
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
  'Run saved searches over the time since each was last checked and return only jobs never seen before. Searches checked under 10 min ago are skipped, and paging stops at the first page with nothing new.',
  {
    names: z.array(z.string().max(60)).max(30).optional().describe('Subset by name; default all'),
    force: z.boolean().optional().describe('Run even searches checked under 10 min ago'),
  },
  ({ names, force }) => run(() => watcher.checkSaved(names, force)),
);

await server.connect(new StdioServerTransport());

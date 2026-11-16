// Davi's part: fresh jobs first, saved searches, and "what is new since I last looked".
import { loadState, saveState, type SavedSearch, type WatchState } from './config.js';
import { LinkedInJobs, type JobCard, type SearchParams } from './linkedin.js';

export type FreshJob = JobCard & { isNew: boolean; matchedKeywords: string };

const MIN_WINDOW_MIN = 15;
const MAX_WINDOW_MIN = 7 * 24 * 60;

export class JobWatcher {
  constructor(
    private jobs: LinkedInJobs,
    private load: () => WatchState = loadState,
    private save: (s: WatchState) => void = saveState,
    private now: () => number = Date.now,
  ) {}

  /** Jobs posted in the last N minutes for one or more keyword sets, newest first, flagged new/seen. */
  async fresh(opts: Omit<SearchParams, 'keywords' | 'datePosted' | 'postedWithinMinutes' | 'sortBy'> & {
    keywords: string[];
    withinMinutes: number;
    onlyNew?: boolean;
  }) {
    const state = this.load();
    const nowIso = new Date(this.now()).toISOString();
    const byId = new Map<string, FreshJob>();
    const errors: string[] = [];
    const warnings = new Set<string>();
    let excludedByTitle = 0;

    for (const kw of opts.keywords) {
      try {
        const res = await this.jobs.search({
          ...opts,
          keywords: kw,
          postedWithinMinutes: opts.withinMinutes,
          sortBy: 'date',
          maxPages: opts.maxPages ?? 2,
        });
        res.warnings?.forEach((w) => warnings.add(`${kw}: ${w}`));
        excludedByTitle += res.excludedByTitle ?? 0;
        for (const job of res.jobs) {
          if (byId.has(job.id)) continue;
          byId.set(job.id, { ...job, isNew: !state.seen[job.id], matchedKeywords: kw });
        }
      } catch (error) {
        // A rate limit stops everything; other errors only skip this keyword.
        if (error instanceof Error && error.name === 'RateLimitError') throw error;
        errors.push(`${kw}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    let list = [...byId.values()].sort((a, b) => (a.minutesAgo ?? 1e9) - (b.minutesAgo ?? 1e9));
    for (const job of list) state.seen[job.id] ??= nowIso;
    this.save(state);
    if (opts.onlyNew) list = list.filter((j) => j.isNew);

    return {
      withinMinutes: opts.withinMinutes,
      total: list.length,
      newCount: list.filter((j) => j.isNew).length,
      ...(excludedByTitle ? { excludedByTitle } : {}),
      ...(warnings.size ? { warnings: [...warnings] } : {}),
      jobs: list,
      ...(errors.length ? { errors } : {}),
    };
  }

  saveSearch(s: Omit<SavedSearch, 'createdAt' | 'lastCheckedAt'>) {
    const state = this.load();
    const name = s.name.trim();
    if (!name) throw new Error('name is required');
    const existing = state.savedSearches.findIndex((x) => x.name.toLowerCase() === name.toLowerCase());
    const entry: SavedSearch = { ...s, name, createdAt: new Date(this.now()).toISOString() };
    if (existing >= 0) state.savedSearches[existing] = { ...entry, lastCheckedAt: state.savedSearches[existing].lastCheckedAt };
    else state.savedSearches.push(entry);
    if (state.savedSearches.length > 30) throw new Error('Limit of 30 saved searches reached; delete one first.');
    this.save(state);
    return { saved: entry, replaced: existing >= 0, total: state.savedSearches.length };
  }

  list() {
    return this.load().savedSearches;
  }

  delete(name: string) {
    const state = this.load();
    const before = state.savedSearches.length;
    state.savedSearches = state.savedSearches.filter((x) => x.name.toLowerCase() !== name.trim().toLowerCase());
    this.save(state);
    return { deleted: before !== state.savedSearches.length, remaining: state.savedSearches.length };
  }

  /** Runs saved searches over the time since each was last checked and returns only jobs never seen before. */
  async checkSaved(names?: string[]) {
    const state = this.load();
    const wanted = names?.length ? new Set(names.map((n) => n.toLowerCase())) : null;
    const targets = state.savedSearches.filter((s) => !wanted || wanted.has(s.name.toLowerCase()));
    if (!targets.length) return { results: [], note: 'No saved searches. Use save-search first.' };

    const results = [];
    for (const s of targets) {
      const since = s.lastCheckedAt ? (this.now() - Date.parse(s.lastCheckedAt)) / 60000 : 24 * 60;
      const withinMinutes = Math.round(Math.min(MAX_WINDOW_MIN, Math.max(MIN_WINDOW_MIN, since + 5)));
      const res = await this.fresh({
        keywords: [s.keywords],
        location: s.location,
        workType: s.workType,
        experienceLevel: s.experienceLevel,
        jobType: s.jobType,
        easyApply: s.easyApply,
        under10Applicants: s.under10Applicants,
        excludeTitle: s.excludeTitle,
        withinMinutes,
        onlyNew: true,
        maxPages: 3,
      });
      const latest = this.load();
      const idx = latest.savedSearches.findIndex((x) => x.name === s.name);
      if (idx >= 0) latest.savedSearches[idx].lastCheckedAt = new Date(this.now()).toISOString();
      this.save(latest);
      results.push({ search: s.name, windowMinutes: withinMinutes, newJobs: res.jobs, ...(res.errors ? { errors: res.errors } : {}) });
    }
    return { totalNew: results.reduce((n, r) => n + r.newJobs.length, 0), results };
  }
}

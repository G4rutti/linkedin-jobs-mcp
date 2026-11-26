import { analyzeFit, type Profile } from './profile.js';
import type { LinkedInJobs } from './linkedin.js';

const ORDER = { good: 0, stretch: 1, unknown: 2, blocked: 3 } as const;

/**
 * Rank postings against the profile. A rate limit does not throw away the work
 * already done: it returns what was ranked plus the ids still pending. Postings
 * already in the cache go first, since they cost no request.
 */
export async function triageJobs(jobs: LinkedInJobs, profile: Profile, jobIds: string[]) {
  const unique = [...new Set(jobIds)];
  const ids = [...unique.filter((id) => jobs.hasDetails(id)), ...unique.filter((id) => !jobs.hasDetails(id))];
  const rows = [];
  const errors: string[] = [];
  const pending: string[] = [];
  let rateLimit: { message: string; pausedForSeconds: number } | undefined;

  for (const [i, id] of ids.entries()) {
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
      if (error instanceof Error && error.name === 'RateLimitError') {
        rateLimit = { message: error.message, pausedForSeconds: (error as Error & { waitSeconds?: number }).waitSeconds ?? 0 };
        pending.push(...ids.slice(i));
        break;
      }
      errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  rows.sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || Number(a.closed) - Number(b.closed));
  return {
    ranked: rows,
    ...(pending.length
      ? { pending, note: 'LinkedIn rate-limited before all postings were opened. The ranked ones are cached; call again with the pending ids after the pause.' }
      : {}),
    ...(rateLimit ? { rateLimit } : {}),
    ...(errors.length ? { errors } : {}),
  };
}

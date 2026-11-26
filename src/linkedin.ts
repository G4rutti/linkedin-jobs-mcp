import * as cheerio from 'cheerio';
import { LinkedInHttpClient } from './http-client.js';
import { TtlCache } from './cache.js';

const GUEST = 'https://www.linkedin.com/jobs-guest/jobs/api';
// The guest search endpoint returns 10 cards per page; fewer means it was the last page.
export const GUEST_PAGE_SIZE = 10;

// Filter maps copied from linkedin-mcp-server (application/search_jobs.py).
export const DATE_POSTED = { past_hour: 3600, past_24_hours: 86400, past_week: 604800, past_month: 2592000 } as const;
export const JOB_TYPE = { full_time: 'F', part_time: 'P', contract: 'C', temporary: 'T', volunteer: 'V', internship: 'I', other: 'O' } as const;
export const EXPERIENCE = { internship: '1', entry: '2', associate: '3', mid_senior: '4', director: '5', executive: '6' } as const;
export const WORK_TYPE = { on_site: '1', remote: '2', hybrid: '3' } as const;
export const SORT = { date: 'DD', relevance: 'R' } as const;

export const JOB_ID = /^\d{6,15}$/;
export function assertJobId(value: string): string {
  const id = String(value ?? '').trim();
  if (!JOB_ID.test(id)) throw new Error(`Invalid LinkedIn job id: ${JSON.stringify(value)} (expected digits only)`);
  return id;
}

function mapList(value: string | undefined, map: Record<string, string>): string | undefined {
  if (!value) return undefined;
  const codes = value.split(',').map((v) => map[v.trim()]).filter(Boolean);
  return codes.length ? codes.join(',') : undefined;
}

export interface SearchParams {
  keywords: string;
  location?: string;
  datePosted?: keyof typeof DATE_POSTED;
  postedWithinMinutes?: number; // finer than datePosted; wins when both are set
  jobType?: string; // comma-separated keys of JOB_TYPE
  experienceLevel?: string; // comma-separated keys of EXPERIENCE
  workType?: string; // comma-separated keys of WORK_TYPE
  easyApply?: boolean;
  under10Applicants?: boolean; // LinkedIn's "Under 10 applicants" filter (f_EA)
  excludeTitle?: string[]; // drop cards whose title contains any of these words (backs up NOT)
  sortBy?: keyof typeof SORT;
  maxPages?: number;
  // Stop paging once a whole page is made of jobs this returns true for
  // (results sorted by date: older pages would be known too).
  stopWhenAllKnown?: (id: string) => boolean;
}

/**
 * LinkedIn keyword Boolean: AND / OR / NOT (uppercase), "straight quotes" and (parentheses).
 * No wildcards, no +/-. Curly quotes silently break phrase matching, so we fix them here.
 */
export function normalizeKeywords(raw: string): { query: string; warnings: string[] } {
  const warnings: string[] = [];
  let q = String(raw ?? '');
  const curly = /[\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/g;
  if (curly.test(q)) {
    q = q.replace(curly, '"');
    warnings.push('Curly quotes replaced with straight quotes.');
  }
  q = q.replace(/[\u2018\u2019]/g, "'");
  if (/\*/.test(q)) {
    q = q.replace(/\*/g, '');
    warnings.push('Wildcards (*) are not supported by LinkedIn and were removed.');
  }
  if (/(^|\s)[+-](?=\w)/.test(q)) warnings.push('+/- operators are not supported by LinkedIn; use AND / NOT.');
  // Uppercase and/or/not outside quoted phrases: lowercase operators are read as plain words.
  let fixedCase = false;
  q = q
    .split(/("[^"]*")/)
    .map((part) =>
      part.startsWith('"') ? part : part.replace(/\b(and|or|not)\b/g, (m) => ((fixedCase = true), m.toUpperCase())),
    )
    .join('');
  if (fixedCase) warnings.push('Lowercase and/or/not were turned into AND/OR/NOT operators.');
  q = q.replace(/\s+/g, ' ').trim();
  if ((q.match(/"/g) ?? []).length % 2) warnings.push('Unbalanced quotes: the phrase search may be ignored.');
  let depth = 0;
  for (const ch of q) if (ch === '(') depth++; else if (ch === ')' && --depth < 0) break;
  if (depth !== 0) warnings.push('Unbalanced parentheses: LinkedIn may scramble the OR/AND logic.');
  if (/\b(AND|OR)\b/.test(q) && /\bOR\b/.test(q) && /\bAND\b/.test(q) && !q.includes('('))
    warnings.push('Mixing AND with OR without parentheses: precedence is quotes > () > NOT > AND > OR.');
  return { query: q, warnings };
}

export function titleExcluded(title: string, words: string[] | undefined): boolean {
  if (!words?.length) return false;
  const t = title.toLowerCase();
  return words.some((w) => {
    const word = w.trim().toLowerCase();
    if (!word) return false;
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, 'u').test(t);
  });
}

export function buildSearchQuery(p: SearchParams, start = 0): URLSearchParams {
  const q = new URLSearchParams({ keywords: normalizeKeywords(p.keywords).query });
  if (p.location) q.set('location', p.location);
  const seconds = p.postedWithinMinutes ? Math.round(p.postedWithinMinutes * 60) : p.datePosted ? DATE_POSTED[p.datePosted] : 0;
  if (seconds) q.set('f_TPR', `r${seconds}`);
  const jt = mapList(p.jobType, JOB_TYPE);
  if (jt) q.set('f_JT', jt);
  const ex = mapList(p.experienceLevel, EXPERIENCE);
  if (ex) q.set('f_E', ex);
  const wt = mapList(p.workType, WORK_TYPE);
  if (wt) q.set('f_WT', wt);
  if (p.easyApply) q.set('f_AL', 'true');
  if (p.under10Applicants) q.set('f_EA', 'true');
  if (p.sortBy) q.set('sortBy', SORT[p.sortBy]);
  if (start) q.set('start', String(start));
  return q;
}

/** "5 minutes ago", "2 hours ago", "há 3 dias" -> minutes. Undefined when unknown. */
export function parseAgo(text: string): number | undefined {
  const t = text.toLowerCase();
  const m = t.match(/(\d+)\s*(second|segundo|minute|minuto|hour|hora|day|dia|week|semana|month|m[eê]s)/);
  if (!m) return /just now|agora/.test(t) ? 0 : undefined;
  const n = Number(m[1]);
  const unit = m[2];
  if (unit.startsWith('sec') || unit.startsWith('seg')) return 0;
  if (unit.startsWith('min')) return n;
  if (unit.startsWith('hour') || unit.startsWith('hora')) return n * 60;
  if (unit.startsWith('day') || unit.startsWith('dia')) return n * 1440;
  if (unit.startsWith('week') || unit.startsWith('semana')) return n * 10080;
  return n * 43200;
}

export interface JobCard {
  id: string;
  title: string;
  company: string;
  location: string;
  postedText: string;
  minutesAgo?: number;
  postedDate: string;
  benefits: string;
  url: string;
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

export function parseSearchHtml(html: string): JobCard[] {
  const $ = cheerio.load(html);
  const out: JobCard[] = [];
  $('[data-entity-urn^="urn:li:jobPosting:"]').each((_, el) => {
    const card = $(el);
    const id = (card.attr('data-entity-urn') ?? '').split(':').pop() ?? '';
    if (!JOB_ID.test(id)) return;
    const time = card.find('time').first();
    const postedText = clean(time.text());
    out.push({
      id,
      title: clean(card.find('.base-search-card__title').text()),
      company: clean(card.find('.base-search-card__subtitle').text()),
      location: clean(card.find('.job-search-card__location').text()),
      postedText,
      minutesAgo: parseAgo(postedText),
      postedDate: time.attr('datetime') ?? '',
      benefits: clean(card.find('.job-posting-benefits__text, .result-benefits__text').text()),
      url: `https://www.linkedin.com/jobs/view/${id}`,
    });
  });
  return out;
}

// Phrases that mean the ad itself says it sponsors a visa / relocates you.
const VISA =
  /(visa sponsor\w*|sponsor\w* (?:a |your |the )?(?:work )?visas?|help with (?:the )?work permit|relocation (?:package|support|assistance|bonus)|relocat\w+ (?:support|assistance|offered)|blue card|we (?:will )?sponsor|patroc\w+ (?:de )?visto)/gi;
const NO_VISA = /(no visa sponsorship|not (?:able to |)(?:offer|provide) (?:visa )?sponsorship|unable to sponsor|do(?:es)? not sponsor|without (?:the need for )?(?:visa )?sponsorship|must (?:already )?have (?:the )?right to work|(?:valid )?work permits? (?:is )?required|(?:already )?(?:eligible|authori[sz]ed|have the right) to work in|arbeitserlaubnis[^.]{0,40}erforderlich|werkvergunning[^.]{0,30}vereist)/gi;

export function visaSignals(text: string): { mentions: string[]; negatives: string[] } {
  const uniq = (m: RegExpMatchArray | null) => [...new Set((m ?? []).map((s) => s.toLowerCase()))];
  return { mentions: uniq(text.match(VISA)), negatives: uniq(text.match(NO_VISA)) };
}

export function parseJobHtml(id: string, html: string) {
  const $ = cheerio.load(html);
  const description = clean($('.show-more-less-html__markup').text());
  const criteria: Record<string, string> = {};
  $('.description__job-criteria-item').each((_, e) => {
    criteria[clean($(e).find('h3').text())] = clean($(e).find('span').text());
  });
  const postedText = clean($('.posted-time-ago__text').first().text());
  const visa = visaSignals(description);
  return {
    id,
    title: clean($('.top-card-layout__title').first().text()),
    company: clean($('.topcard__org-name-link').first().text()),
    companyUrl: ($('.topcard__org-name-link').attr('href') ?? '').split('?')[0],
    location: clean($('.topcard__flavor--bullet').first().text()),
    postedText,
    minutesAgo: parseAgo(postedText),
    applicants: clean($('.num-applicants__caption').first().text()),
    closed: /no longer accepting applications/i.test($('.closed-job, .top-card-layout__entity-info').text()),
    criteria,
    visaMentions: visa.mentions, // empty = the ad does not say it sponsors
    visaNegatives: visa.negatives,
    description,
    url: `https://www.linkedin.com/jobs/view/${id}`,
  };
}

export type JobDetails = ReturnType<typeof parseJobHtml>;
type Extras = Record<string, unknown>;

export interface JobsCaches {
  // Parsed search pages, keyed by URL. Short TTL: listings move fast.
  search?: TtlCache<JobCard[]>;
  // Parsed public posting. Descriptions rarely change; applicants/closed may lag by the TTL.
  details?: TtlCache<JobDetails>;
  // Logged-in extras (applicant count, applied flag). Shorter TTL.
  extras?: TtlCache<Extras>;
}

export const SEARCH_TTL_MS = 5 * 60 * 1000;
export const DETAILS_TTL_MS = 6 * 60 * 60 * 1000;
export const EXTRAS_TTL_MS = 60 * 60 * 1000;

export class LinkedInJobs {
  readonly caches: Required<JobsCaches>;
  private extrasOffUntil = 0;
  // The logged-in extras call LinkedIn's internal API with your cookie, which is the
  // riskiest request this server makes and was never verified live. Opt-in only.
  private extrasEnabled = process.env.LINKEDIN_EXTRAS === '1';

  constructor(
    private http: LinkedInHttpClient,
    // Title words to drop when a call does not pass excludeTitle (from the user's profile).
    private defaultExclude: () => string[] | undefined = () => undefined,
    caches: JobsCaches = {},
  ) {
    this.caches = {
      search: caches.search ?? new TtlCache<JobCard[]>(SEARCH_TTL_MS, 200),
      details: caches.details ?? new TtlCache<JobDetails>(DETAILS_TTL_MS, 300),
      extras: caches.extras ?? new TtlCache<Extras>(EXTRAS_TTL_MS, 300),
    };
  }

  async search(p: SearchParams) {
    const maxPages = Math.max(1, Math.min(p.maxPages ?? 1, 10));
    const seen = new Set<string>();
    const jobs: JobCard[] = [];
    const { warnings } = normalizeKeywords(p.keywords);
    const exclude = p.excludeTitle ?? this.defaultExclude();
    let excludedByTitle = 0;
    let requests = 0;
    let start = 0;
    let stoppedEarly: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      // Public endpoints: no cookies, so scraping is never tied to your account.
      const url = `${GUEST}/seeMoreJobPostings/search?${buildSearchQuery(p, start)}`;
      let cards = this.caches.search.get(url)?.value;
      if (!cards) {
        const res = await this.http.get(url, { useSession: false });
        requests++;
        cards = parseSearchHtml(res.text);
        this.caches.search.set(url, cards);
      }
      if (!cards.length) break;
      for (const c of cards) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        if (titleExcluded(c.title, exclude)) excludedByTitle++;
        else jobs.push(c);
      }
      start += cards.length;
      if (page + 1 >= maxPages) break;
      if (cards.length < GUEST_PAGE_SIZE) {
        stoppedEarly = 'last page';
        break;
      }
      if (p.stopWhenAllKnown && cards.every((c) => p.stopWhenAllKnown!(c.id))) {
        stoppedEarly = 'only already-seen jobs on this page';
        break;
      }
    }
    return {
      query: Object.fromEntries(buildSearchQuery(p)),
      ...(warnings.length ? { warnings } : {}),
      returned: jobs.length,
      ...(excludedByTitle ? { excludedByTitle } : {}),
      requests,
      ...(stoppedEarly ? { stoppedEarly } : {}),
      nextStart: start,
      jobs,
    };
  }

  hasDetails(rawId: string): boolean {
    try {
      return !!this.caches.details.peek(assertJobId(rawId));
    } catch {
      return false;
    }
  }

  /**
   * One public request per job (cached for hours), plus one logged-in request
   * for the extras only when `extras` is true and a session exists.
   */
  async details(rawId: string, { extras, refresh = false }: { extras?: boolean; refresh?: boolean } = {}) {
    const id = assertJobId(rawId);
    const hit = refresh ? undefined : this.caches.details.get(id);
    let job: JobDetails;
    let cachedAt: string | undefined;
    if (hit) {
      job = hit.value;
      cachedAt = new Date(hit.at).toISOString();
    } else {
      const res = await this.http.get(`${GUEST}/jobPosting/${id}`, { useSession: false });
      if (res.status === 404 || !res.text) throw new Error(`Job ${id} not found (it may have been removed).`);
      job = parseJobHtml(id, res.text);
      this.caches.details.set(id, job);
    }
    const wantExtras = extras ?? this.extrasEnabled;
    const extra = wantExtras && this.http.hasSession() ? await this.sessionExtras(id, refresh) : undefined;
    return { ...job, ...(cachedAt ? { cachedAt } : {}), ...(extra ? { session: extra } : {}) };
  }

  // Logged-in extras (exact publish time, applicant count, easy apply, whether
  // you already applied). Uses LinkedIn's internal web API with your session.
  // Not verified against a live account yet: any failure just drops the extras.
  private async sessionExtras(id: string, refresh = false): Promise<Extras> {
    const hit = refresh ? undefined : this.caches.extras.get(id);
    if (hit) return { ...hit.value, cachedAt: new Date(hit.at).toISOString() };
    if (Date.now() < this.extrasOffUntil) return { note: 'Logged-in extras skipped: they failed recently, retrying in under 1 h.' };
    try {
      const jsession = /JSESSIONID="?([^";]+)"?/.exec(this.cookies())?.[1];
      if (!jsession) return { note: 'Session has no JSESSIONID cookie; run login-with-browser again for logged-in extras.' };
      const res = await this.http.getWithHeaders(
        `https://www.linkedin.com/voyager/api/jobs/jobPostings/${id}?decorationId=com.linkedin.voyager.deco.jobs.web.shared.WebFullJobPosting-65`,
        { 'csrf-token': jsession, 'x-restli-protocol-version': '2.0.0', accept: 'application/json' },
      );
      const d = JSON.parse(res.text)?.data ?? JSON.parse(res.text);
      const extras: Extras = {
        listedAt: d.listedAt ? new Date(d.listedAt).toISOString() : undefined,
        minutesSinceListed: d.listedAt ? Math.round((Date.now() - d.listedAt) / 60000) : undefined,
        applies: d.applies,
        views: d.views,
        easyApply: d.applyMethod ? /ComplexOnsiteApply|SimpleOnsiteApply/.test(JSON.stringify(d.applyMethod)) : undefined,
        alreadyApplied: d.applyingInfo?.applied ?? undefined,
        remoteAllowed: d.workRemoteAllowed,
      };
      this.caches.extras.set(id, extras);
      return extras;
    } catch (error) {
      if (error instanceof Error && /Paused|rate limit|checkpoint|expired/i.test(error.message)) throw error;
      // Broken endpoint or changed API: stop spending a request per job on it for a while.
      this.extrasOffUntil = Date.now() + 60 * 60 * 1000;
      return { note: `Logged-in extras unavailable: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private cookies(): string {
    return this.http.cookieHeader();
  }
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkedInHttpClient, RateLimitError, SessionExpiredError, BlockedUrlError } from './http-client.js';
import { assertJobId, buildSearchQuery, parseAgo, visaSignals, LinkedInJobs, normalizeKeywords, titleExcluded } from './linkedin.js';
import { JobWatcher } from './watch.js';
import { triageJobs } from './triage.js';
import type { RuntimeState, WatchState } from './config.js';

const SESSION = 'li_at=SECRET; JSESSIONID="ajax:1"';
type Call = { url: string; headers: Record<string, string> };

function mockClient(responses: Array<{ status: number; body?: string; location?: string }>, cookies = SESSION) {
  const calls: Call[] = [];
  let t = 0;
  const fetchImpl = (async (url: URL, init: RequestInit) => {
    calls.push({ url: url.toString(), headers: init.headers as Record<string, string> });
    const r = responses.shift() ?? { status: 200, body: '' };
    return new Response(r.body ?? '', { status: r.status === 999 ? 599 : r.status, headers: r.location ? { location: r.location } : {} }) as Response & { status: number };
  }) as unknown as typeof fetch;
  const client = new LinkedInHttpClient({ getCookies: () => cookies, fetchImpl, minIntervalMs: 0, now: () => (t += 1), sleep: async () => {} });
  return { client, calls };
}

test('never sends cookies to a non-LinkedIn URL', async () => {
  const { client, calls } = mockClient([]);
  for (const u of ['https://linkedin.com.evil.com/x', 'https://evillinkedin.com/x', 'http://www.linkedin.com/x']) {
    await assert.rejects(client.get(u), BlockedUrlError);
  }
  assert.equal(calls.length, 0);
});

test('does not follow a redirect off linkedin.com with the session', async () => {
  const { client, calls } = mockClient([{ status: 302, location: 'https://attacker.example/steal' }]);
  await assert.rejects(client.get('https://www.linkedin.com/voyager/api/me'), BlockedUrlError);
  assert.equal(calls.length, 1);
});

test('public endpoints never carry the session cookie', async () => {
  const { client, calls } = mockClient([{ status: 200, body: '<li></li>' }]);
  await new LinkedInJobs(client).search({ keywords: 'react' });
  assert.equal(calls[0].headers.cookie, undefined);
});

test('rate limit pauses everything and does not retry', async () => {
  const { client, calls } = mockClient([{ status: 429 }]);
  await assert.rejects(client.get('https://www.linkedin.com/jobs/x'), RateLimitError);
  await assert.rejects(client.get('https://www.linkedin.com/jobs/y'), /Paused/);
  assert.equal(calls.length, 1);
  assert.ok(client.cooldownRemainingSeconds() > 0);
});

test('a security checkpoint redirect triggers the pause', async () => {
  const { client } = mockClient([{ status: 302, location: '/checkpoint/challenge/abc' }]);
  await assert.rejects(client.get('https://www.linkedin.com/jobs/x'), RateLimitError);
});

test('authwall redirect means the session expired', async () => {
  const { client } = mockClient([{ status: 302, location: 'https://www.linkedin.com/authwall?x=1' }]);
  await assert.rejects(client.get('https://www.linkedin.com/jobs/x'), SessionExpiredError);
});

test('rejects malformed job ids before any request', async () => {
  const { client, calls } = mockClient([]);
  for (const id of ['../me', '123', '4489680030/../x', 'abc4489680030']) assert.throws(() => assertJobId(id));
  await assert.rejects(new LinkedInJobs(client).details('../../voyager/api/me'));
  assert.equal(calls.length, 0);
});

test('filters map to LinkedIn codes and minutes win over datePosted', () => {
  const q = buildSearchQuery({ keywords: 'full stack', workType: 'remote,hybrid', experienceLevel: 'entry,associate', datePosted: 'past_week', postedWithinMinutes: 30, sortBy: 'date', easyApply: true });
  assert.equal(q.get('f_WT'), '2,3');
  assert.equal(q.get('f_E'), '2,3');
  assert.equal(q.get('f_TPR'), 'r1800');
  assert.equal(q.get('sortBy'), 'DD');
  assert.equal(q.get('f_AL'), 'true');
});

test('parses "ago" texts in English and Portuguese', () => {
  assert.equal(parseAgo('12 minutes ago'), 12);
  assert.equal(parseAgo('2 hours ago'), 120);
  assert.equal(parseAgo('há 3 dias'), 4320);
  assert.equal(parseAgo('Just now'), 0);
  assert.equal(parseAgo(''), undefined);
});

test('visa signals separate positive and negative wording', () => {
  const v = visaSignals('We offer visa sponsorship and a relocation package. ');
  assert.deepEqual(v.mentions, ['visa sponsorship', 'relocation package']);
  assert.deepEqual(visaSignals('Unfortunately we do not sponsor work visas.').negatives, ['do not sponsor']);
});

test('fresh-jobs flags new vs seen and check-saved only returns unseen', async () => {
  const card = (id: string, ago: string) => `<li><div data-entity-urn="urn:li:jobPosting:${id}"><h3 class="base-search-card__title">Dev ${id}</h3><time datetime="2026-11-16">${ago}</time></div></li>`;
  let state: WatchState = { savedSearches: [], seen: {} };
  const { client } = mockClient([
    // Short pages (< 10 cards) are the last page, so no empty page 2 is requested.
    { status: 200, body: card('1000001', '5 minutes ago') + card('1000002', '1 hour ago') },
    { status: 200, body: card('1000002', '1 hour ago') + card('1000003', '2 minutes ago') },
  ]);
  const w = new JobWatcher(new LinkedInJobs(client), () => structuredClone(state), (s) => (state = structuredClone(s)), () => Date.parse('2026-11-16T06:00:00Z'));
  const first = await w.fresh({ keywords: ['dev'], withinMinutes: 60 });
  assert.deepEqual(first.jobs.map((j) => j.id), ['1000001', '1000002']);
  assert.equal(first.newCount, 2);
  w.saveSearch({ name: 'dev', keywords: 'dev' });
  const check = await w.checkSaved();
  assert.deepEqual(check.results[0].newJobs.map((j) => j.id), ['1000003']);
  assert.ok(state.savedSearches[0].lastCheckedAt);
});

test('normalizeKeywords fixes curly quotes, lowercase operators and wildcards', () => {
  const r = normalizeKeywords('\u201Cfull stack\u201D or react* and not "research and development"');
  assert.equal(r.query, '"full stack" OR react AND NOT "research and development"');
  assert.ok(r.warnings.some((w) => /Curly/.test(w)));
  assert.ok(r.warnings.some((w) => /Wildcards/.test(w)));
  assert.ok(r.warnings.some((w) => /parentheses: precedence/.test(w)));
  assert.deepEqual(normalizeKeywords('("a" OR b) AND c').warnings, []);
  assert.ok(normalizeKeywords('(a OR b').warnings.some((w) => /Unbalanced parentheses/.test(w)));
});

test('under10Applicants maps to f_EA and keywords are normalized in the URL', () => {
  const q = buildSearchQuery({ keywords: 'react or vue', under10Applicants: true });
  assert.equal(q.get('f_EA'), 'true');
  assert.equal(q.get('keywords'), 'react OR vue');
});

test('titleExcluded matches whole words only', () => {
  assert.equal(titleExcluded('Senior Full Stack Engineer', ['senior']), true);
  assert.equal(titleExcluded('(Senior) Full-Stack Developer', ['senior']), true);
  assert.equal(titleExcluded('Full Stack Engineer', ['senior', 'lead']), false);
  assert.equal(titleExcluded('Leading Edge Full Stack Developer', ['lead']), false);
  assert.equal(titleExcluded('Internal Tools Developer', ['intern']), false);
});

// ── Request savings ───────────────────────────────────────────────────────────

const cards = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) => `<li><div data-entity-urn="urn:li:jobPosting:${from + i}"><h3 class="base-search-card__title">Dev ${from + i}</h3><time>1 hour ago</time></div></li>`).join('');

test('search stops paging on a short page', async () => {
  const { client, calls } = mockClient([{ status: 200, body: cards(2000000, 4) }]);
  const r = await new LinkedInJobs(client).search({ keywords: 'react', maxPages: 5 });
  assert.equal(calls.length, 1);
  assert.equal(r.returned, 4);
  assert.equal(r.stoppedEarly, 'last page');
});

test('search stops paging when a full page is all already-seen jobs', async () => {
  const { client, calls } = mockClient([{ status: 200, body: cards(3000000, 10) }, { status: 200, body: cards(3000010, 10) }]);
  const r = await new LinkedInJobs(client).search({ keywords: 'react', maxPages: 5, stopWhenAllKnown: () => true });
  assert.equal(calls.length, 1);
  assert.equal(r.requests, 1);
});

test('repeating a search within the TTL makes no new request', async () => {
  const { client, calls } = mockClient([{ status: 200, body: cards(4000000, 3) }]);
  const jobs = new LinkedInJobs(client);
  await jobs.search({ keywords: 'react' });
  const again = await jobs.search({ keywords: 'react' });
  assert.equal(calls.length, 1);
  assert.equal(again.requests, 0);
  assert.equal(again.returned, 3);
});

test('job details are cached and triage-style calls skip the logged-in extras', async () => {
  const html = '<h2 class="top-card-layout__title">Dev</h2><div class="show-more-less-html__markup">React</div>';
  const { client, calls } = mockClient([{ status: 200, body: html }]);
  const jobs = new LinkedInJobs(client);
  await jobs.details('4489680030', { extras: false });
  const cached = await jobs.details('4489680030', { extras: false });
  assert.equal(calls.length, 1);
  assert.ok(!calls.some((c) => c.url.includes('/voyager/')));
  assert.ok(cached.cachedAt);
});

test('check-saved skips searches checked minutes ago unless forced', async () => {
  let state: WatchState = { savedSearches: [{ name: 'dev', keywords: 'dev', createdAt: '2026-11-16T05:00:00Z', lastCheckedAt: '2026-11-16T05:58:00Z' }], seen: {} };
  const { client, calls } = mockClient([{ status: 200, body: cards(5000000, 2) }]);
  const w = new JobWatcher(new LinkedInJobs(client), () => structuredClone(state), (s) => (state = structuredClone(s)), () => Date.parse('2026-11-16T06:00:00Z'));
  const skipped = await w.checkSaved();
  assert.equal(calls.length, 0);
  assert.equal('skipped' in skipped ? skipped.skipped?.length : 0, 1);
  const forced = await w.checkSaved(undefined, true);
  assert.equal(calls.length, 1);
  assert.equal('totalNew' in forced ? forced.totalNew : 0, 2);
});

test('the rate-limit pause survives a restart and records who was blocked', async () => {
  let saved: RuntimeState | undefined;
  const blocked = new LinkedInHttpClient({
    getCookies: () => SESSION, minIntervalMs: 0, sleep: async () => {},
    fetchImpl: (async () => ({ status: 429, headers: new Headers(), text: async () => '' })) as unknown as typeof fetch,
    saveRuntime: (r) => (saved = r),
  });
  await assert.rejects(blocked.get('https://www.linkedin.com/jobs-guest/jobs/api/x', { useSession: false }), RateLimitError);
  assert.equal(saved?.lastBlock?.withSession, false);
  assert.equal(saved?.lastBlock?.path, '/jobs-guest/jobs/api/x');
  let calls = 0;
  const restarted = new LinkedInHttpClient({
    getCookies: () => SESSION, minIntervalMs: 0, sleep: async () => {},
    fetchImpl: (async () => (calls++, new Response('ok'))) as unknown as typeof fetch,
    loadRuntime: () => saved!,
  });
  await assert.rejects(restarted.get('https://www.linkedin.com/jobs/y'), /Paused/);
  assert.equal(calls, 0);
});

test('a redirect loop stops at the first repeated URL instead of walking 6 hops', async () => {
  const { client, calls } = mockClient([
    { status: 302, location: 'https://www.linkedin.com/voyager/api/x' },
    { status: 302, location: 'https://www.linkedin.com/voyager/api/x' },
    { status: 302, location: 'https://www.linkedin.com/voyager/api/x' },
  ]);
  await assert.rejects(client.get('https://www.linkedin.com/voyager/api/x'), /Redirect loop.*\/voyager\/api\/x -> \/voyager\/api\/x/);
  assert.equal(calls.length, 1);
});

test('every redirect hop goes through the throttle', async () => {
  let t = 0;
  let sleeps = 0;
  const responses = [{ status: 302, location: '/jobs/b' }, { status: 302, location: '/jobs/c' }, { status: 200 }];
  const fetchImpl = (async () => {
    const r = responses.shift()!;
    return new Response('ok', { status: r.status, headers: r.location ? { location: r.location } : {} });
  }) as unknown as typeof fetch;
  const client = new LinkedInHttpClient({ getCookies: () => SESSION, fetchImpl, minIntervalMs: 1000, jitterFactor: 0, now: () => t, sleep: async (ms) => { sleeps++; t += ms; } });
  await client.get('https://www.linkedin.com/jobs/a');
  assert.equal(sleeps, 3);
});

test('logged-in extras are off by default, even with a session', async () => {
  const html = '<h2 class="top-card-layout__title">Dev</h2><div class="show-more-less-html__markup">React</div>';
  const { client, calls } = mockClient([{ status: 200, body: html }]);
  await new LinkedInJobs(client).details('5489680030');
  assert.equal(calls.length, 1);
  assert.ok(!calls.some((c) => c.url.includes('/voyager/')));
});

const posting = (title: string) => `<h2 class="top-card-layout__title">${title}</h2><div class="show-more-less-html__markup">React and Node.js</div>`;

test('triage keeps what it ranked and lists the rest as pending when LinkedIn rate-limits', async () => {
  const { client, calls } = mockClient([{ status: 200, body: posting('Full Stack Dev') }, { status: 429 }, { status: 200, body: posting('never reached') }]);
  const r = await triageJobs(new LinkedInJobs(client), { skills: ['React'] }, ['6000001', '6000002', '6000003']);
  assert.equal(r.ranked.length, 1);
  assert.equal(r.ranked[0].id, '6000001');
  assert.deepEqual(r.pending, ['6000002', '6000003']);
  assert.ok(r.rateLimit && r.rateLimit.pausedForSeconds > 0);
  assert.equal(calls.length, 2);
});

test('triage opens cached postings first and spends no request on them', async () => {
  const { client, calls } = mockClient([{ status: 200, body: posting('Cached One') }, { status: 429 }]);
  const jobs = new LinkedInJobs(client);
  await jobs.details('7000001');
  const r = await triageJobs(jobs, { skills: ['React'] }, ['7000002', '7000001']);
  assert.equal(r.ranked.length, 1);
  assert.deepEqual(r.pending, ['7000002']);
  assert.equal(calls.length, 2);
});

test('a block soon after the previous one doubles the pause, and it survives a restart', async () => {
  let saved: RuntimeState | undefined;
  let t = 0;
  const mk = (load?: RuntimeState) =>
    new LinkedInHttpClient({
      getCookies: () => SESSION, minIntervalMs: 0, sleep: async () => {}, now: () => t,
      fetchImpl: (async () => new Response('', { status: 429 })) as unknown as typeof fetch,
      saveRuntime: (r) => (saved = r), loadRuntime: load ? () => load : undefined,
    });
  const first = mk();
  await assert.rejects(first.get('https://www.linkedin.com/jobs-guest/x', { useSession: false }), /Paused for 15 min/);
  t += 16 * 60 * 1000; // first pause is over
  const second = mk(saved);
  await assert.rejects(second.get('https://www.linkedin.com/jobs-guest/x', { useSession: false }), /Paused for 30 min.*block 2/);
  assert.equal(saved?.strikes, 2);
  t += 31 * 60 * 1000;
  await assert.rejects(mk(saved).get('https://www.linkedin.com/jobs-guest/x', { useSession: false }), /Paused for 60 min/);
  t += 3 * 60 * 60 * 1000; // quiet for 3 h: back to 15 min
  await assert.rejects(mk(saved).get('https://www.linkedin.com/jobs-guest/x', { useSession: false }), /Paused for 15 min/);
});

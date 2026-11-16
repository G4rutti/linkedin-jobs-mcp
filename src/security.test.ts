import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkedInHttpClient, RateLimitError, SessionExpiredError, BlockedUrlError } from './http-client.js';
import { assertJobId, buildSearchQuery, parseAgo, visaSignals, LinkedInJobs, normalizeKeywords, titleExcluded } from './linkedin.js';
import { JobWatcher } from './watch.js';
import type { WatchState } from './config.js';

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
    { status: 200, body: card('1000001', '5 minutes ago') + card('1000002', '1 hour ago') }, { status: 200, body: '' },
    { status: 200, body: card('1000002', '1 hour ago') + card('1000003', '2 minutes ago') }, { status: 200, body: '' },
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

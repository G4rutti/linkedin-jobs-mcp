import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityTime, companyFrom, loc, parseCompany, parseContact, parseExperience, parseFollowing, parseMain, parsePosts, parseRecommendations, parseSkills, usernameFrom } from './person.js';

const NOW = { y: 2026, m: 11 };
const T = (n: string) => `com.linkedin.voyager.dash.${n}`;
const profileDoc = {
  data: { '*elements': [] },
  included: [
    { $type: T('identity.profile.Profile'), entityUrn: 'urn:li:fsd_profile:ABC', publicIdentifier: 'jane-doe', multiLocaleFirstName: { pt_BR: 'Janete', en_US: 'Jane' }, lastName: 'Doe', multiLocaleHeadline: { pt_BR: 'Desenvolvedora', en_US: 'Developer' }, summary: 'About me', '*followingInfo': 'urn:li:fsd_fi:1' },
    { $type: T('common.Geo'), defaultLocalizedName: 'Berlin, Germany' },
    { $type: 'x.FollowingInfo', entityUrn: 'urn:li:fsd_fi:1', followerCount: 321 },
    { $type: T('identity.profile.Position'), title: 'Engineer', companyName: 'Initech', companyUrn: 'urn:li:fsd_company:9', dateRange: { start: { year: 2024, month: 1 }, end: { year: 2024, month: 12 } }, description: 'Built things' },
    { $type: T('identity.profile.Position'), title: 'Senior Engineer', companyName: 'Hooli', dateRange: { start: { year: 2025, month: 3 } } },
    { $type: T('organization.Company'), entityUrn: 'urn:li:fsd_company:9', name: 'Initech', url: 'https://x/company/initech' },
    { $type: T('identity.profile.Skill'), name: 'API REST' },
    { $type: T('identity.profile.Skill'), name: 'Docker' },
    { $type: T('identity.profile.Skill'), name: 'docker' },
    { $type: 'x.CollectionResponse', '*elements': ['urn:li:fsd_skill:1'], paging: { total: 5 } },
  ],
};

test('main: prefers English names and finds location, followers and urn', () => {
  const m = parseMain([profileDoc], 'jane-doe')!;
  assert.equal(m.name, 'Jane Doe');
  assert.equal(m.headline, 'Developer');
  assert.equal(m.location, 'Berlin, Germany');
  assert.equal(m.followers, 321);
  assert.equal(m.profileUrn, 'urn:li:fsd_profile:ABC');
});

test('experience: newest first, "present" for open ranges, months computed', () => {
  const x = parseExperience([profileDoc], NOW);
  assert.equal(x[0].title, 'Senior Engineer');
  assert.equal(x[0].end, 'present');
  assert.equal(x[0].durationMonths, 21);
  assert.equal(x[1].company, 'Initech');
  assert.equal(x[1].companyUrl, 'https://x/company/initech');
  assert.equal(x[1].durationMonths, 12);
});

test('skills: deduplicated, localized names mapped, total reported', () => {
  const s = parseSkills([profileDoc]);
  assert.deepEqual(s.skills, ['REST API', 'Docker']);
  assert.equal(s.total, 5);
});

test('contact info', () => {
  const c = parseContact({ data: { emailAddress: { emailAddress: 'a@b.co' }, phoneNumbers: [{ phoneNumber: { number: '123' }, type: 'MOBILE' }], websites: [{ url: 'https://x.dev', category: 'PORTFOLIO' }], birthDateOn: { month: 3, day: 9 }, twitterHandles: [], publicIdentifier: 'jane-doe' } })!;
  assert.equal(c.email, 'a@b.co');
  assert.deepEqual(c.phones, [{ number: '123', type: 'mobile' }]);
  assert.equal(c.birthday, '03-09');
  assert.equal(c.linkedinUrl, 'https://www.linkedin.com/in/jane-doe');
});

test('recommendations: author resolved by direction, deleted ignored', () => {
  const doc = { included: [
    { $type: 'x.Recommendation', recommendationText: 'Great', relationship: 'COLLEAGUE', created: Date.UTC(2025, 0, 5), '*recommender': 'urn:p:1', '*recommendee': 'urn:p:2', status: 'VISIBLE' },
    { $type: 'x.Recommendation', recommendationText: 'Old', '*recommender': 'urn:p:1', status: 'DELETED' },
    { $type: 'x.MiniProfile', entityUrn: 'urn:p:1', firstName: 'Ann', lastName: 'Lee', occupation: 'CTO', publicIdentifier: 'ann' },
  ] };
  const r = parseRecommendations(doc, 'received');
  assert.equal(r.length, 1);
  assert.equal(r[0].person?.name, 'Ann Lee');
  assert.equal(r[0].date, '2025-01-05');
});

test('posts: counts through SocialDetail, time from the activity id, limit applied', () => {
  const id = (BigInt(Date.UTC(2025, 5, 1)) << 22n).toString();
  const doc = { included: [
    { $type: 'x.UpdateV2', commentary: { text: { text: 'Hello' } }, socialContent: { shareUrl: 'https://l/p' }, updateMetadata: { urn: `urn:li:activity:${id}` }, '*socialDetail': 'sd1' },
    { $type: 'x.UpdateV2', commentary: { text: { text: 'Second' } } },
    { $type: 'x.SocialDetail', entityUrn: 'sd1', '*totalSocialActivityCounts': 'c1' },
    { $type: 'x.SocialActivityCounts', entityUrn: 'c1', numLikes: 7, numComments: 2, numShares: 1 },
  ] };
  const p = parsePosts(doc, 1);
  assert.equal(p.length, 1);
  assert.equal(p[0].reactions, 7);
  assert.equal(p[0].postedAt?.slice(0, 10), '2025-06-01');
  assert.equal(activityTime('urn:li:activity:123'), undefined);
});

test('company about and following', () => {
  const doc = { included: [
    { $type: 'x.Company', entityUrn: 'urn:li:fs_normalized_company:42', universalName: 'acme', name: 'Acme', description: 'We make things', companyPageUrl: 'https://acme.test', staffCountRange: { start: 51, end: 200 }, specialities: ['a'], '*companyIndustries': ['i1'], '*followingInfo': 'f1', confirmedLocations: [{ city: 'Oslo', country: 'NO', headquarter: true }] },
    { $type: 'x.Industry', entityUrn: 'i1', localizedName: 'Software' },
    { $type: 'x.FollowingInfo', entityUrn: 'f1', followerCount: 99 },
  ] };
  const c = parseCompany(doc)!;
  assert.equal(c.companyId, '42');
  assert.equal(c.industry, 'Software');
  assert.equal(c.size, '51-200');
  assert.equal(c.headquarters, 'Oslo, NO');
  assert.equal(c.followers, 99);
  assert.deepEqual(parseFollowing({ included: [{ $type: 'x.MiniCompany', name: 'Acme', universalName: 'acme' }] }), [{ type: 'company', name: 'Acme', url: 'https://www.linkedin.com/company/acme/' }]);
});

test('inputs: URLs accepted, junk rejected, loc falls back', () => {
  assert.equal(usernameFrom('https://www.linkedin.com/in/jane-doe/?x=1'), 'jane-doe');
  assert.throws(() => usernameFrom('a/../b'));
  assert.equal(companyFrom('https://www.linkedin.com/company/acme/'), 'acme');
  assert.throws(() => companyFrom('a b;c'));
  assert.equal(loc({ multiLocaleName: { pt_BR: 'x' }, name: 'y' }, 'name'), 'x');
});

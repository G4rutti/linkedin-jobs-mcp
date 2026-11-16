// Person and company profile reader (sections, like linkedin-mcp-server's get_person_profile).
// Parsers are pure (JSON in, typed object out) so they are tested with synthetic fixtures;
// the fetchers only add the HTTP calls and a per-section diagnostic, so one section failing
// never hides the others.
import { monthsUnion, type Ym } from './profile-import.js';
import type { LinkedInHttpClient } from './http-client.js';

type Json = Record<string, any>;

export const PERSON_SECTIONS = ['experience', 'education', 'contact_info', 'interests', 'honors', 'languages', 'posts', 'recommendations'] as const;
export const COMPANY_SECTIONS = ['posts', 'jobs'] as const;
export type PersonSection = (typeof PERSON_SECTIONS)[number];
export type CompanySection = (typeof COMPANY_SECTIONS)[number];

// ---------- helpers ----------
const typeOf = (e: Json) => String(e?.$type ?? '').split('.').pop() ?? '';
function entities(docs: Json[]): Json[] {
  const out: Json[] = [];
  for (const d of docs) {
    if (Array.isArray(d?.included)) out.push(...d.included);
    if (d?.data && typeof d.data === 'object') out.push(d.data);
  }
  return out;
}
function indexByUrn(list: Json[]): Map<string, Json> {
  const m = new Map<string, Json>();
  for (const e of list) if (typeof e?.entityUrn === 'string') m.set(e.entityUrn, e);
  return m;
}
/** Prefers English from LinkedIn's multi-locale maps (en_US), then any locale, then the plain field. */
export function loc(e: Json | undefined, field: string): string | undefined {
  if (!e) return undefined;
  const ml = e[`multiLocale${field[0].toUpperCase()}${field.slice(1)}`];
  if (ml && typeof ml === 'object') {
    const v = ml.en_US ?? ml.en_GB ?? Object.values(ml).find((x) => typeof x === 'string' && x);
    if (typeof v === 'string' && v) return v;
  }
  return typeof e[field] === 'string' && e[field] ? e[field] : undefined;
}
const ym = (d: any): string | undefined =>
  d && typeof d.year === 'number' ? `${d.year}${typeof d.month === 'number' ? '-' + String(d.month).padStart(2, '0') : ''}` : undefined;
const ymObj = (d: any): Ym | undefined => (d && typeof d.year === 'number' ? { y: d.year, m: typeof d.month === 'number' ? d.month : undefined } : undefined);
export function imageUrl(img: any): string | undefined {
  const v = img?.vectorImage ?? img?.displayImageReference?.vectorImage ?? img?.image?.['com.linkedin.common.VectorImage'] ?? img?.image ?? img;
  const root = v?.rootUrl;
  const arts: Json[] = Array.isArray(v?.artifacts) ? v.artifacts : [];
  const best = arts.reduce<Json | undefined>((a, b) => (!a || (b.width ?? 0) > (a.width ?? 0) ? b : a), undefined);
  return typeof root === 'string' && best?.fileIdentifyingUrlPathSegment ? root + best.fileIdentifyingUrlPathSegment : undefined;
}
/** LinkedIn activity ids carry their creation time in the high bits (id >> 22 = epoch ms). */
export function activityTime(urn: string | undefined): string | undefined {
  const m = /(?:activity|ugcPost|share):(\d{15,22})/.exec(urn ?? '');
  if (!m) return undefined;
  try {
    const ms = Number(BigInt(m[1]) >> 22n);
    return ms > 1.2e12 && ms < 4e12 ? new Date(ms).toISOString() : undefined;
  } catch {
    return undefined;
  }
}
// LinkedIn returns skill names in the account's language; map the common ones to the English form.
const SKILL_EN: Record<string, string> = {
  'integração e entrega contínuas (ci/cd)': 'CI/CD',
  'geração aumentada de recuperação (rag)': 'RAG',
  'desenvolvimento de ia generativa': 'Generative AI',
  'api rest': 'REST API',
  'inteligência artificial (ia)': 'Artificial Intelligence',
  'aprendizado de máquina': 'Machine Learning',
  'desenvolvimento de software': 'Software Development',
  'desenvolvimento front-end': 'Front-End Development',
  'desenvolvimento back-end': 'Back-End Development',
  'banco de dados': 'Databases',
  'metodologias ágeis': 'Agile Methodologies',
  'computação em nuvem': 'Cloud Computing',
  'windows azure': 'Microsoft Azure',
};
const skillName = (e: Json) => {
  const n = loc(e, 'name') ?? '';
  return SKILL_EN[n.toLowerCase()] ?? n;
};

// ---------- person: main, experience, education, languages, certifications, skills ----------
export function parseMain(docs: Json[], id?: string) {
  const all = entities(docs);
  const byUrn = indexByUrn(all);
  const profiles = all.filter((e) => typeOf(e) === 'Profile');
  const p = profiles.find((e) => id && e.publicIdentifier === id) ?? profiles.find((e) => e.headline || e.multiLocaleHeadline) ?? profiles[0];
  if (!p) return undefined;
  const first = loc(p, 'firstName');
  const last = loc(p, 'lastName');
  const geo = all.find((e) => typeOf(e) === 'Geo' && e.defaultLocalizedName);
  const following = typeof p['*followingInfo'] === 'string' ? byUrn.get(p['*followingInfo']) : undefined;
  return {
    name: [first, last].filter(Boolean).join(' ') || undefined,
    username: p.publicIdentifier as string | undefined,
    profileUrn: typeof p.entityUrn === 'string' ? (p.entityUrn as string) : undefined,
    headline: loc(p, 'headline'),
    location: geo?.defaultLocalizedName as string | undefined,
    about: loc(p, 'summary'),
    followers: typeof following?.followerCount === 'number' ? following.followerCount : undefined,
    profileImage: imageUrl(p.profilePicture),
  };
}

export function parseExperience(docs: Json[], now: Ym) {
  const all = entities(docs);
  const byUrn = indexByUrn(all);
  const rows = all
    .filter((e) => typeOf(e) === 'Position' && typeof e.title === 'string')
    .map((e) => {
      const dr = e.dateRange ?? e.timePeriod ?? {};
      const start = ymObj(dr.start);
      const end = ymObj(dr.end);
      const company = typeof e.companyUrn === 'string' ? byUrn.get(e.companyUrn) : undefined;
      const type = typeof e.employmentTypeUrn === 'string' ? byUrn.get(e.employmentTypeUrn) : undefined;
      return {
        title: loc(e, 'title') ?? e.title,
        company: e.companyName ?? company?.name,
        companyUrl: company?.url as string | undefined,
        companyLogo: imageUrl(company?.logo),
        employmentType: type?.name as string | undefined,
        location: e.locationName as string | undefined,
        start: ym(dr.start),
        end: end ? ym(dr.end) : start ? 'present' : undefined,
        durationMonths: start ? monthsUnion([{ start, end }], now) : undefined,
        description: loc(e, 'description'),
      };
    });
  return rows.sort((a, b) => (b.start ?? '').localeCompare(a.start ?? ''));
}

export function parseEducation(docs: Json[]) {
  const all = entities(docs);
  const byUrn = indexByUrn(all);
  return all
    .filter((e) => typeOf(e) === 'Education')
    .map((e) => {
      const dr = e.dateRange ?? {};
      const school = typeof e.schoolUrn === 'string' ? byUrn.get(e.schoolUrn) : undefined;
      return {
        school: e.schoolName ?? school?.name,
        schoolUrl: school?.url as string | undefined,
        schoolLogo: imageUrl(school?.logo),
        degree: e.degreeName as string | undefined,
        fieldOfStudy: e.fieldOfStudy as string | undefined,
        start: ym(dr.start),
        end: ym(dr.end),
        grade: e.grade as string | undefined,
        activities: e.activities as string | undefined,
        description: loc(e, 'description'),
      };
    })
    .sort((a, b) => (b.start ?? '').localeCompare(a.start ?? ''));
}

export function parseLanguageList(docs: Json[]) {
  return entities(docs)
    .filter((e) => typeOf(e) === 'Language' && typeof e.name === 'string')
    .map((e) => ({ language: e.name as string, proficiency: (e.proficiency as string | undefined)?.toLowerCase().replace(/_/g, ' ') }));
}

export function parseCertifications(docs: Json[]) {
  return entities(docs)
    .filter((e) => typeOf(e) === 'Certification' && typeof e.name === 'string')
    .map((e) => ({ name: e.name as string, authority: e.authority as string | undefined, issued: ym(e.dateRange?.start), expires: ym(e.dateRange?.end), url: e.url as string | undefined }));
}

export function parseSkills(docs: Json[]) {
  const all = entities(docs);
  const seen = new Set<string>();
  const skills = all
    .filter((e) => typeOf(e) === 'Skill')
    .map(skillName)
    .filter((n) => n && !seen.has(n.toLowerCase()) && (seen.add(n.toLowerCase()), true));
  let total: number | undefined;
  for (const e of all) {
    if (typeOf(e) !== 'CollectionResponse') continue;
    const first = (e['*elements'] ?? [])[0];
    if (typeof first === 'string' && /skill/i.test(first) && typeof e.paging?.total === 'number') total = e.paging.total;
  }
  return { skills, total };
}

// ---------- person: contact, interests, honors, recommendations, posts ----------
export function parseContact(doc: Json) {
  const d = doc?.data && !doc.data.status ? doc.data : doc;
  if (!d || typeof d !== 'object') return undefined;
  const b = d.birthDateOn;
  return {
    email: d.emailAddress?.emailAddress as string | undefined,
    phones: (d.phoneNumbers ?? []).map((p: Json) => ({ number: p.phoneNumber?.number as string, type: String(p.type ?? '').toLowerCase() })).filter((p: Json) => p.number),
    websites: (d.websites ?? []).map((w: Json) => ({ url: w.url as string, label: String(w.category ?? '').toLowerCase() })).filter((w: Json) => w.url),
    twitter: (d.twitterHandles ?? []).map((t: Json) => t.name ?? t).filter((t: unknown) => typeof t === 'string'),
    birthday: b && typeof b.month === 'number' ? `${String(b.month).padStart(2, '0')}-${String(b.day ?? 1).padStart(2, '0')}` : undefined,
    address: typeof d.address === 'string' ? d.address : undefined,
    linkedinUrl: d.publicIdentifier ? `https://www.linkedin.com/in/${d.publicIdentifier}` : undefined,
  };
}

export function parseFollowing(doc: Json) {
  const out: Array<{ type: 'company' | 'group'; name: string; url?: string }> = [];
  for (const e of entities([doc])) {
    const t = typeOf(e);
    if (t === 'MiniCompany' && e.name) out.push({ type: 'company', name: e.name, url: e.universalName ? `https://www.linkedin.com/company/${e.universalName}/` : undefined });
    else if (t === 'MiniGroup' && e.groupName) out.push({ type: 'group', name: e.groupName, url: e.objectUrn ? `https://www.linkedin.com/groups/${String(e.objectUrn).split(':').pop()}/` : undefined });
    else if (t === 'MiniGroup' && e.name) out.push({ type: 'group', name: e.name });
  }
  return out;
}

export function parseHonors(doc: Json) {
  const items: Json[] = [...(doc?.data?.elements ?? []), ...entities([doc]).filter((e) => /^(Honor|Award)$/.test(typeOf(e)))];
  return items
    .filter((h) => h && (h.title || h.name))
    .map((h) => ({ title: (h.title ?? h.name) as string, issuer: h.issuer as string | undefined, issued: ym(h.issueDate), description: h.description as string | undefined }));
}

export function parseRecommendations(doc: Json, direction: 'received' | 'given') {
  const all = entities([doc]);
  const byUrn = indexByUrn(all);
  return all
    .filter((e) => typeOf(e) === 'Recommendation' && e.status !== 'DELETED')
    .map((e) => {
      const who = byUrn.get(e[direction === 'received' ? '*recommender' : '*recommendee']);
      return {
        direction,
        text: e.recommendationText as string | undefined,
        relationship: e.relationship as string | undefined,
        date: typeof e.created === 'number' ? new Date(e.created).toISOString().slice(0, 10) : undefined,
        person: who ? { name: [who.firstName, who.lastName].filter(Boolean).join(' '), headline: who.occupation as string | undefined, username: who.publicIdentifier as string | undefined } : undefined,
      };
    });
}

export function parsePosts(doc: Json, limit: number) {
  const all = entities([doc]);
  const byUrn = indexByUrn(all);
  const out: Array<Json> = [];
  for (const e of all) {
    if (typeOf(e) !== 'UpdateV2') continue;
    const detail = typeof e['*socialDetail'] === 'string' ? byUrn.get(e['*socialDetail']) : undefined;
    const counts = typeof detail?.['*totalSocialActivityCounts'] === 'string' ? byUrn.get(detail['*totalSocialActivityCounts']) : undefined;
    const urn = e.updateMetadata?.urn as string | undefined;
    out.push({
      text: e.commentary?.text?.text as string | undefined,
      url: e.socialContent?.shareUrl as string | undefined,
      postedAt: activityTime(urn),
      reactions: counts?.numLikes,
      comments: counts?.numComments,
      shares: counts?.numShares,
    });
    if (out.length >= limit) break;
  }
  return out;
}

// ---------- company ----------
export function parseCompany(doc: Json) {
  const all = entities([doc]);
  const byUrn = indexByUrn(all);
  const c = all.find((e) => typeOf(e) === 'Company' && e.universalName);
  if (!c) return undefined;
  const hq = (c.confirmedLocations ?? []).find((l: Json) => l.headquarter) ?? (c.confirmedLocations ?? [])[0];
  const inds = (c['*companyIndustries'] ?? []).map((u: string) => byUrn.get(u)?.localizedName).filter(Boolean);
  const fi = typeof c['*followingInfo'] === 'string' ? byUrn.get(c['*followingInfo']) : undefined;
  const range = c.staffCountRange;
  return {
    name: c.name as string,
    universalName: c.universalName as string,
    companyId: String(c.entityUrn ?? '').split(':').pop(),
    tagline: c.tagline as string | undefined,
    overview: c.description as string | undefined,
    website: c.companyPageUrl as string | undefined,
    industry: inds.join(', ') || undefined,
    size: range ? `${range.start}-${range.end ?? '+'}` : undefined,
    employeesOnLinkedIn: c.staffCount as number | undefined,
    headquarters: hq ? [hq.city, hq.geographicArea, hq.country].filter(Boolean).join(', ') : undefined,
    specialties: (c.specialities ?? []) as string[],
    followers: fi?.followerCount as number | undefined,
    logo: imageUrl(c.logo),
    url: `https://www.linkedin.com/company/${c.universalName}/`,
  };
}

export function parseCompanyJobs(doc: Json, limit: number) {
  return entities([doc])
    .filter((e) => typeOf(e) === 'JobPosting' && typeof e.title === 'string')
    .slice(0, limit)
    .map((e) => {
      const jobId = /(\d{6,})$/.exec(String(e.entityUrn ?? ''))?.[1];
      return { jobId, title: e.title as string, url: jobId ? `https://www.linkedin.com/jobs/view/${jobId}/` : undefined };
    });
}

// ---------- input validation ----------
export function usernameFrom(raw: string): string {
  const s = raw.trim();
  const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(s);
  const u = decodeURIComponent(m ? m[1] : s);
  if (!/^[\p{L}\p{N}\-_%]{3,100}$/u.test(u)) throw new Error('Invalid LinkedIn username. Use the part after /in/ in the profile URL.');
  return u;
}
export function companyFrom(raw: string): string {
  const s = raw.trim();
  const m = /linkedin\.com\/company\/([^/?#]+)/i.exec(s);
  const u = decodeURIComponent(m ? m[1] : s);
  if (!/^[\p{L}\p{N}\-_.%]{1,100}$/u.test(u)) throw new Error('Invalid company name. Use the part after /company/ in the company URL.');
  return u;
}

// ---------- fetchers ----------
const BASE = 'https://www.linkedin.com/voyager/api';
const PROFILE_DECO = 'com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-93';
const CONTACT_DECO = 'com.linkedin.voyager.dash.deco.identity.profile.ProfileContactInfo-1';
const COMPANY_DECO = 'com.linkedin.voyager.deco.organization.web.WebFullCompanyMain-12';
const JOBS_DECO = 'com.linkedin.voyager.dash.deco.jobs.search.JobSearchCardsCollection-220';

function apiHeaders(http: LinkedInHttpClient) {
  const js = /JSESSIONID="?([^";]+)"?/.exec(http.cookieHeader())?.[1];
  if (!js) throw new Error('Session has no JSESSIONID cookie; run login-with-browser again.');
  return { 'csrf-token': js, 'x-restli-protocol-version': '2.0.0', accept: 'application/vnd.linkedin.normalized+json+2.1' };
}
const fatal = (e: unknown) => e instanceof Error && /RateLimitError|SessionExpiredError|BlockedUrlError/.test(e.name);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface Section<T = unknown> {
  data?: T;
  error?: string;
}

export async function fetchPerson(
  http: LinkedInHttpClient,
  opts: { username?: string; sections: PersonSection[]; postsLimit: number },
  now: Ym,
) {
  const h = apiHeaders(http);
  const get = async (path: string): Promise<Json> => JSON.parse((await http.getWithHeaders(BASE + path, h)).text);
  let id = opts.username;
  const own = !id;
  if (!id) {
    const me = await get('/me');
    id = (me.data?.publicIdentifier ?? me.miniProfile?.publicIdentifier ?? (me.included ?? []).find((e: Json) => e.publicIdentifier)?.publicIdentifier) as string | undefined;
    if (!id) throw new Error('Could not identify your LinkedIn account from the saved session. Run login-with-browser again.');
  }
  const enc = encodeURIComponent(id);
  const result: Json = { username: id, source: own ? 'your own account (saved session)' : 'username you passed' };
  const errors: Record<string, string> = {};
  const want = new Set(opts.sections);
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      if (fatal(e)) throw e;
      errors[name] = msg(e);
    }
  };

  let profileDoc: Json | undefined;
  await step('main', async () => {
    profileDoc = await get(`/identity/dash/profiles?q=memberIdentity&memberIdentity=${enc}&decorationId=${PROFILE_DECO}`);
    const main = parseMain([profileDoc], id);
    if (!main) throw new Error('Profile not found or not visible to your account.');
    result.main = main;
    if (own) {
      await step('connections', async () => {
        const c = await get('/relationships/connectionsSummary');
        const n = c.data?.numConnections ?? c.numConnections;
        if (typeof n === 'number') result.main.connections = n;
      });
    }
  });
  if (profileDoc) {
    if (want.has('experience')) result.experience = parseExperience([profileDoc], now);
    if (want.has('education')) result.education = parseEducation([profileDoc]);
    if (want.has('languages')) result.languages = parseLanguageList([profileDoc]);
    const sk = parseSkills([profileDoc]);
    result.skills = sk.skills;
    if (sk.total && sk.total > sk.skills.length) result.skillsNote = `LinkedIn lists ${sk.total} skills; its API returned ${sk.skills.length}.`;
    const certs = parseCertifications([profileDoc]);
    if (certs.length) result.certifications = certs;
  }
  const urn = result.main?.profileUrn as string | undefined;
  if (want.has('contact_info'))
    await step('contact_info', async () => {
      if (!urn) throw new Error('Needs the main profile first.');
      result.contact_info = parseContact(await get(`/identity/dash/profiles/${encodeURIComponent(urn)}?decorationId=${CONTACT_DECO}`));
    });
  if (want.has('interests'))
    await step('interests', async () => {
      const companies = parseFollowing(await get(`/identity/profiles/${enc}/following?count=50&entityType=COMPANY&q=followedEntities`));
      let groups: ReturnType<typeof parseFollowing> = [];
      await step('interests_groups', async () => {
        groups = parseFollowing(await get(`/identity/profiles/${enc}/following?count=50&entityType=GROUP&q=followedEntities`));
      });
      result.interests = { companies: companies.filter((x) => x.type === 'company'), groups: groups.filter((x) => x.type === 'group'), note: 'People followed are not exposed by this endpoint.' };
    });
  if (want.has('honors'))
    await step('honors', async () => {
      result.honors = parseHonors(await get(`/identity/profiles/${enc}/honors`));
    });
  if (want.has('recommendations'))
    await step('recommendations', async () => {
      const received = parseRecommendations(await get(`/identity/profiles/${enc}/recommendations?q=received&count=20`), 'received');
      let given: ReturnType<typeof parseRecommendations> = [];
      await step('recommendations_given', async () => {
        given = parseRecommendations(await get(`/identity/profiles/${enc}/recommendations?q=given&count=20`), 'given');
      });
      result.recommendations = { received, given };
    });
  if (want.has('posts'))
    await step('posts', async () => {
      if (!urn) throw new Error('Needs the main profile first.');
      const doc = await get(`/identity/profileUpdatesV2?count=${opts.postsLimit}&start=0&q=memberShareFeed&moduleKey=member-shares%3Aphone&includeLongTermHistory=true&profileUrn=${encodeURIComponent(urn)}`);
      result.posts = parsePosts(doc, opts.postsLimit);
    });
  if (Object.keys(errors).length) result.errors = errors;
  return result;
}

export async function fetchCompany(http: LinkedInHttpClient, opts: { company: string; sections: CompanySection[]; limit: number }) {
  const h = apiHeaders(http);
  const get = async (path: string): Promise<Json> => JSON.parse((await http.getWithHeaders(BASE + path, h)).text);
  const name = encodeURIComponent(opts.company);
  const result: Json = {};
  const errors: Record<string, string> = {};
  const doc = await get(`/organization/companies?decorationId=${COMPANY_DECO}&q=universalName&universalName=${name}`);
  const about = parseCompany(doc);
  if (!about) throw new Error(`Company "${opts.company}" not found.`);
  result.about = about;
  const want = new Set(opts.sections);
  if (want.has('posts'))
    try {
      result.posts = parsePosts(await get(`/organization/updatesV2?companyIdOrUniversalName=${name}&q=companyRelevanceFeed&moduleKey=ORGANIZATION_MEMBER_FEED_DESKTOP&count=${opts.limit}&start=0`), opts.limit);
    } catch (e) {
      if (fatal(e)) throw e;
      errors.posts = msg(e);
    }
  if (want.has('jobs'))
    try {
      result.jobs = parseCompanyJobs(
        await get(`/voyagerJobsDashJobCards?decorationId=${JOBS_DECO}&q=jobSearch&query=(origin:COMPANY_PAGE_JOBS_CLUSTER_EXPANSION,locationUnion:(geoId:92000000),selectedFilters:(company:List(${about.companyId})))&start=0&count=${opts.limit}`),
        opts.limit,
      );
    } catch (e) {
      if (fatal(e)) throw e;
      errors.jobs = msg(e);
    }
  if (Object.keys(errors).length) result.errors = errors;
  return result;
}

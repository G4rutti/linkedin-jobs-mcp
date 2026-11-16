// Build a Profile from a LinkedIn profile or from pasted text (CV, LinkedIn "Save to PDF").
// Nothing here is guessed from thin air: every field comes from a date range, a skills
// list or a languages list that is actually in the source, and `notes` says what was not found.
import type { LinkedInHttpClient } from './http-client.js';
import type { LangLevel, Profile, Seniority } from './profile.js';

export interface Ym {
  y: number;
  m?: number;
}
export interface Range {
  start: Ym;
  end?: Ym; // undefined = still there
  title?: string;
}
export interface Imported {
  profile: Pick<Profile, 'seniority' | 'yearsExperience' | 'skills' | 'languages'>;
  positions: Array<{ title?: string; from: string; to: string }>;
  notes: string[];
}

// ── dates ────────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = { jan: 1, fev: 2, feb: 2, mar: 3, mrt: 3, abr: 4, apr: 4, mai: 5, may: 5, mei: 5, jun: 6, jul: 7, ago: 8, aug: 8, set: 9, sep: 9, out: 10, oct: 10, okt: 10, nov: 11, dez: 12, dec: 12 };
const deaccent = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

function monthNum(token?: string): number | undefined {
  if (!token) return undefined;
  const t = deaccent(token.trim().toLowerCase()).replace(/[./]/g, '');
  if (/^\d{1,2}$/.test(t)) {
    const n = Number(t);
    return n >= 1 && n <= 12 ? n : undefined;
  }
  return MONTHS[t.slice(0, 3)];
}

const MONTH = '(?:[A-Za-zÀ-ÿ]{3,9}\\.?\\s+|\\d{1,2}\\/)';
const DATE = `(${MONTH})?(\\d{4})`;
const PRESENT = '(present|current|now|presente|atual|atualmente|heute|heden|aujourd.hui|actualidad)';
const RANGE_SRC = `${DATE}\\s*(?:-|–|—|to|até|bis|tot|a)\\s*(?:${DATE}|${PRESENT})`;
const DURATION = /\(\s*\d+\s*(?:years?|yrs?|months?|mos?|anos?|meses|mês|jahre?|monate?)[^)]*\)/gi;

const toIdx = (ym: Ym, kind: 'start' | 'end', now: Ym) =>
  ym.y * 12 + ((ym.m ?? (kind === 'start' ? 1 : ym.y === now.y ? (now.m ?? 12) : 12)) - 1);

/** Distinct months covered by the ranges (overlaps counted once, future dates ignored). */
export function monthsUnion(ranges: Range[], now: Ym): number {
  const nowIdx = toIdx(now, 'end', now);
  const covered = new Set<number>();
  for (const r of ranges) {
    if (r.start.y < 1970) continue;
    const a = toIdx(r.start, 'start', now);
    const b = Math.min(r.end ? toIdx(r.end, 'end', now) : nowIdx, nowIdx);
    for (let i = a; i <= b; i++) covered.add(i);
  }
  return covered.size;
}

const label = (ym: Ym | undefined) => (ym ? `${ym.y}${ym.m ? `-${String(ym.m).padStart(2, '0')}` : ''}` : 'present');

// ── seniority ────────────────────────────────────────────────────────────────

const TITLE_LEVEL: Array<[RegExp, Seniority]> = [
  [/\b(head of|director|principal|staff|tech lead|team lead|lead|architect|líder)\b/i, 'lead'],
  [/\b(senior|sênior|sr)\b\.?/i, 'senior'],
  [/\b(pleno|mid[- ]?level|medior|mid)\b/i, 'mid'],
  [/\b(junior|júnior|jr|graduate|entry[- ]level|trainee)\b\.?/i, 'junior'],
  [/\b(intern|internship|estagi\w+|werkstudent|praktikant)\b/i, 'intern'],
];

export function inferSeniority(ranges: Range[], years: number): { seniority: Seniority; from: 'title' | 'years' } {
  const current = ranges.filter((r) => !r.end && r.title).map((r) => r.title!);
  const latest = [...ranges].filter((r) => r.title).sort((a, b) => b.start.y * 12 + (b.start.m ?? 0) - (a.start.y * 12 + (a.start.m ?? 0)))[0]?.title;
  const titles = current.length ? current : latest ? [latest] : [];
  for (const t of titles) for (const [re, level] of TITLE_LEVEL) if (re.test(t)) return { seniority: level, from: 'title' };
  return { seniority: years < 0.5 ? 'intern' : years < 3 ? 'junior' : years < 6 ? 'mid' : 'senior', from: 'years' };
}

// ── languages ────────────────────────────────────────────────────────────────

const LANG_CODES: Record<string, string> = {
  english: 'en', inglês: 'en', ingles: 'en', englisch: 'en', engels: 'en',
  portuguese: 'pt', português: 'pt', portugues: 'pt', portugiesisch: 'pt', portugees: 'pt',
  german: 'de', alemão: 'de', alemao: 'de', deutsch: 'de', duits: 'de',
  dutch: 'nl', holandês: 'nl', holandes: 'nl', nederlands: 'nl', niederländisch: 'nl',
  french: 'fr', francês: 'fr', frances: 'fr', français: 'fr', francais: 'fr', französisch: 'fr', frans: 'fr',
  spanish: 'es', espanhol: 'es', español: 'es', espanol: 'es', spanisch: 'es', spaans: 'es',
  italian: 'it', italiano: 'it', italienisch: 'it', italiaans: 'it',
  polish: 'pl', polonês: 'pl', polones: 'pl', polski: 'pl', polnisch: 'pl', pools: 'pl',
};

function mapLevel(raw: string): LangLevel | undefined {
  const t = deaccent(raw.toLowerCase());
  const cefr = /\b(a1|a2|b1|b2|c1|c2)\b/i.exec(raw)?.[1]?.toUpperCase();
  if (cefr) return cefr as LangLevel;
  if (/native|bilingual|nativo|mother|muttersprach|moedertaal|fluente nativo/.test(t)) return 'native';
  if (/full professional|proficient|advanced|avancado|fluent|fluente|fliessend|vloeiend/.test(t)) return 'C1';
  if (/professional working|upper[- ]intermediate|intermediario|gute/.test(t)) return 'B2';
  if (/limited working|intermediate|basic working/.test(t)) return 'B1';
  if (/elementary|basic|basico|beginner|grundkenntnisse|iniciante/.test(t)) return 'A2';
  return undefined;
}

const LEVEL_FROM_LINKEDIN: Record<string, LangLevel> = {
  NATIVE_OR_BILINGUAL: 'native', FULL_PROFESSIONAL: 'C1', PROFESSIONAL_WORKING: 'B2', LIMITED_WORKING: 'B1', ELEMENTARY: 'A2',
};

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if ((ch === ',' || ch === ';' || ch === '·' || ch === '•' || ch === '|') && depth === 0) (out.push(cur), (cur = ''));
    else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

export function parseLanguages(chunks: string[]): { languages: Record<string, LangLevel>; skipped: string[] } {
  const languages: Record<string, LangLevel> = {};
  const skipped: string[] = [];
  for (const chunk of chunks) {
    for (const entry of splitTopLevel(chunk)) {
      const m = /^([A-Za-zÀ-ÿ]+)\s*(?:\(([^)]*)\)|[:–—-]\s*(.+))?$/.exec(entry);
      const code = m && LANG_CODES[m[1].toLowerCase()];
      if (!code) continue;
      const level = mapLevel(m![2] ?? m![3] ?? '');
      if (level) languages[code] = level;
      else skipped.push(`${m![1]} (no level stated)`);
    }
  }
  return { languages, skipped };
}

// ── skills ───────────────────────────────────────────────────────────────────

const KNOWN_SKILLS = [
  'JavaScript', 'TypeScript', 'Python', 'Java', 'Kotlin', 'Swift', 'Golang', 'Rust', 'C#', 'C++', 'PHP', 'Ruby', 'Scala', 'Dart', 'SQL', 'HTML', 'CSS',
  'React', 'Next.js', 'Vue.js', 'Angular', 'Svelte', 'Redux', 'Zustand', 'TanStack Query', 'Tailwind CSS', 'shadcn/ui', 'Vite', 'Webpack',
  'Node.js', 'Express', 'NestJS', 'FastAPI', 'Django', 'Flask', 'Spring Boot', 'Laravel', '.NET', 'GraphQL', 'REST APIs', 'gRPC',
  'PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'SQLite', 'Elasticsearch', 'Kafka', 'RabbitMQ', 'Prisma', 'Supabase', 'Firebase',
  'Docker', 'Kubernetes', 'Terraform', 'AWS', 'Azure', 'GCP', 'Databricks', 'Snowflake', 'Git', 'GitHub Actions', 'CI/CD', 'Jenkins', 'Linux', 'Vercel',
  'LangChain', 'LangGraph', 'LlamaIndex', 'RAG', 'OpenAI', 'Claude', 'Gemini', 'LLM', 'MCP', 'PyTorch', 'TensorFlow', 'scikit-learn', 'Pandas', 'NumPy', 'Spark', 'Airflow', 'dbt',
  'Jest', 'Vitest', 'Cypress', 'Playwright', 'Selenium', 'pytest', 'Storybook', 'Figma', 'Jira', 'Scrum', 'Kanban',
  'React Native', 'Flutter', 'Android', 'iOS', 'Keycloak', 'OAuth',
];
const CASE_SENSITIVE = new Set([...KNOWN_SKILLS.filter((s) => s.length <= 4), 'Express', 'Claude', 'Gemini', 'Scrum', 'Kanban']);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

export function scanKnownSkills(text: string): string[] {
  return KNOWN_SKILLS.filter((s) => new RegExp(`(^|[^\\p{L}\\p{N}+#])${esc(s)}($|[^\\p{L}\\p{N}+#])`, CASE_SENSITIVE.has(s) ? 'u' : 'iu').test(text));
}

function parseSkillLines(lines: string[]): string[] {
  const out: string[] = [];
  for (let line of lines) {
    const label = /^([^:,]{1,40}):\s*(.*)$/.exec(line);
    if (label) {
      if (/^languages?$|^idiomas$|^sprachen$/i.test(label[1].trim())) continue;
      line = label[2];
    }
    line = line.replace(/\([^)]*\)/g, '');
    for (const tok of line.split(/[,;·•|]|\s\/\s/)) {
      const t = tok.trim().replace(/\.$/, '');
      if (t.length < 2 || t.length > 40 || t.split(/\s+/).length > 4 || /proficiency|^and$/i.test(t)) continue;
      out.push(t);
    }
  }
  const seen = new Set<string>();
  return out.filter((s) => (seen.has(s.toLowerCase()) ? false : (seen.add(s.toLowerCase()), true)));
}

// ── text import ──────────────────────────────────────────────────────────────

const HEADERS: Array<[RegExp, string]> = [
  [/^((professional|work) )?experience$|^experiência( profissional)?$|^berufserfahrung$|^werkervaring$|^employment( history)?$/i, 'experience'],
  [/^(education|educação|formação( acadêmica)?|ausbildung|opleiding|academic background)$/i, 'education'],
  [/^((technical|top|key|core) )?(skills|competências|habilidades|competencies|fähigkeiten|vaardigheden)$/i, 'skills'],
  [/^(languages|idiomas|línguas|sprachen|talen)$/i, 'languages'],
  [/^((selected|personal) )?(ai )?projects?$|^projetos$|^projekte$|^certifications?$|^certificações$|^awards$|^honors.*$|^publications$|^(professional )?summary$|^about$|^resumo$|^volunteer.*$/i, 'other'],
];
const EDU_LINE = /\b(b\.?sc|m\.?sc|bachelor|master|university|universidade|faculdade|college|school|technician|técnico|degree|gpa|expected|hackathon|award|prize|place)\b/i;

function splitSections(text: string): Record<string, string[]> {
  const sections: Record<string, string[]> = { top: [] };
  let current = 'top';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const bare = line.replace(/:$/, '');
    const header = bare.length <= 40 ? HEADERS.find(([re]) => re.test(bare)) : undefined;
    if (header) {
      current = header[1];
      (sections[current] ??= []);
      continue;
    }
    (sections[current] ??= []).push(line);
  }
  return sections;
}

export function parseRangesFromLines(lines: string[]): Range[] {
  const out: Range[] = [];
  let prev = '';
  for (const line of lines) {
    const re = new RegExp(RANGE_SRC, 'giu');
    let m: RegExpExecArray | null;
    let found = false;
    while ((m = re.exec(line))) {
      const y1 = Number(m[2]);
      const y2 = m[4] ? Number(m[4]) : undefined;
      if (y1 < 1970 || (y2 !== undefined && y2 < y1)) continue;
      found = true;
      let title = line.replace(new RegExp(RANGE_SRC, 'giu'), ' ').replace(DURATION, ' ').replace(/^[\s—–\-·|•,]+|[\s—–\-·|•,]+$/g, '').replace(/\s+/g, ' ');
      if (!title) title = prev;
      out.push({ start: { y: y1, m: monthNum(m[1]) }, end: y2 ? { y: y2, m: monthNum(m[3]) } : undefined, title: title.slice(0, 120) || undefined });
    }
    if (!found) prev = line;
  }
  return out;
}

export function fromRanges(ranges: Range[], skills: string[], languages: Record<string, LangLevel>, now: Ym, notes: string[]): Imported {
  const profile: Imported['profile'] = {};
  if (ranges.length) {
    const years = Math.round((monthsUnion(ranges, now) / 12) * 10) / 10;
    const s = inferSeniority(ranges, years);
    profile.yearsExperience = years;
    profile.seniority = s.seniority;
    notes.push(`seniority "${s.seniority}" came from ${s.from === 'title' ? 'your current job title' : 'the years of experience'}`);
  } else notes.push('No job dates found: seniority and years were not set.');
  if (skills.length) profile.skills = skills.slice(0, 60);
  else notes.push('No skills found.');
  if (Object.keys(languages).length) profile.languages = languages;
  else notes.push('No languages with a level found: set them with set-profile.');
  return {
    profile,
    positions: ranges.map((r) => ({ title: r.title, from: label(r.start), to: label(r.end) })),
    notes,
  };
}

export function importFromText(text: string, now: Ym = { y: new Date().getFullYear(), m: new Date().getMonth() + 1 }): Imported {
  const notes: string[] = [];
  const sections = splitSections(text);
  const expLines = sections.experience ?? Object.entries(sections).filter(([k]) => k !== 'education').flatMap(([, v]) => v).filter((l) => !EDU_LINE.test(l));
  if (!sections.experience) notes.push('No "Experience" section found: used every dated line outside education.');
  const ranges = parseRangesFromLines(expLines);

  let skills = sections.skills ? parseSkillLines(sections.skills) : [];
  if (!skills.length) {
    skills = scanKnownSkills(text);
    if (skills.length) notes.push('No "Skills" section found: skills are the known technologies mentioned in the text.');
  }

  const langChunks = [...(sections.languages ?? [])];
  for (const lines of Object.values(sections)) for (const l of lines) {
    const inline = /^languages?\s*:\s*(.+)$/i.exec(l);
    if (inline) langChunks.push(inline[1]);
  }
  const { languages, skipped } = parseLanguages(langChunks);
  if (skipped.length) notes.push(`Languages without a level were skipped: ${skipped.join(', ')}.`);
  return fromRanges(ranges, skills, languages, now, notes);
}

// ── LinkedIn (own profile, through your saved session) ───────────────────────

type Json = Record<string, any>;

function entitiesOf(doc: Json): Json[] {
  const items: Json[] = [];
  const push = (v: unknown) => Array.isArray(v) && v.forEach((x) => x && typeof x === 'object' && items.push(x));
  push(doc.included);
  push(doc.elements);
  push(doc.data?.elements);
  push(doc.data?.['*elements']);
  if (doc.data && typeof doc.data === 'object') items.push(doc.data);
  return items;
}
const typeOf = (e: Json) => String(e.$type ?? e._type ?? '').split('.').pop() ?? '';
const ymOf = (d: any): Ym | undefined => (d && typeof d.year === 'number' ? { y: d.year, m: typeof d.month === 'number' ? d.month : undefined } : undefined);

export function parseVoyager(docs: Json[], now: Ym, notes: string[] = []): Imported {
  const ranges: Range[] = [];
  const skills: string[] = [];
  const languages: Record<string, LangLevel> = {};
  for (const doc of docs) {
    for (const e of entitiesOf(doc)) {
      const t = typeOf(e);
      if (/^Position$/i.test(t) && typeof e.title === 'string') {
        const dr = e.dateRange ?? e.timePeriod ?? {};
        const start = ymOf(dr.start ?? dr.startDate);
        if (start) ranges.push({ start, end: ymOf(dr.end ?? dr.endDate), title: e.title });
      } else if (/^Skill$/i.test(t) && typeof e.name === 'string') skills.push(e.name);
      else if (/^Language$/i.test(t) && typeof e.name === 'string') {
        const code = LANG_CODES[e.name.toLowerCase()];
        const level = LEVEL_FROM_LINKEDIN[String(e.proficiency ?? '')];
        if (code && level) languages[code] = level;
      }
    }
  }
  const seen = new Set<string>();
  const uniq = skills.filter((s) => (seen.has(s.toLowerCase()) ? false : (seen.add(s.toLowerCase()), true)));
  return fromRanges(ranges, uniq, languages, now, notes);
}

function findKey(obj: unknown, key: string, budget = { n: 5000 }): string | undefined {
  if (!obj || typeof obj !== 'object' || budget.n-- <= 0) return undefined;
  const rec = obj as Json;
  if (typeof rec[key] === 'string' && rec[key]) return rec[key];
  for (const v of Object.values(rec)) {
    const hit = findKey(v, key, budget);
    if (hit) return hit;
  }
  return undefined;
}

const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
export function codeBlocks(html: string): Json[] {
  const docs: Json[] = [];
  for (const m of html.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/g)) {
    try {
      const j = JSON.parse(decode(m[1].trim()));
      if (j && typeof j === 'object') docs.push(j);
    } catch {
      /* not JSON */
    }
  }
  return docs;
}

const typeHistogram = (docs: Json[]) => {
  const h: Record<string, number> = {};
  for (const d of docs) for (const e of entitiesOf(d)) h[typeOf(e) || '(none)'] = (h[typeOf(e) || '(none)'] ?? 0) + 1;
  return Object.fromEntries(Object.entries(h).sort((a, b) => b[1] - a[1]).slice(0, 15));
};

export interface OwnProfileResult {
  imported: Imported;
  diagnostics: Array<{ step: string; status: string; entityTypes?: Record<string, number> }>;
}

/** Reads ONLY the account that owns the saved session (identity comes from /me, never from input). */
export async function fetchOwnProfile(http: LinkedInHttpClient, now: Ym): Promise<OwnProfileResult> {
  const jsession = /JSESSIONID="?([^";]+)"?/.exec(http.cookieHeader())?.[1];
  if (!jsession) throw new Error('Session has no JSESSIONID cookie; run login-with-browser again.');
  const api = { 'csrf-token': jsession, 'x-restli-protocol-version': '2.0.0', accept: 'application/vnd.linkedin.normalized+json+2.1' };
  const diagnostics: OwnProfileResult['diagnostics'] = [];
  const rethrow = (e: unknown) => {
    if (e instanceof Error && /RateLimitError|SessionExpiredError|BlockedUrlError/.test(e.name)) throw e;
  };

  let id: string | undefined;
  try {
    const me = JSON.parse((await http.getWithHeaders('https://www.linkedin.com/voyager/api/me', api)).text);
    id = findKey(me, 'publicIdentifier');
    diagnostics.push({ step: 'me', status: id ? 'ok' : 'no publicIdentifier in response' });
  } catch (e) {
    rethrow(e);
    diagnostics.push({ step: 'me', status: e instanceof Error ? e.message : String(e) });
  }
  if (!id) throw new Error(`Could not identify your LinkedIn account from the saved session. Diagnostics: ${JSON.stringify(diagnostics)}. Use import-profile with text instead.`);

  const docs: Json[] = [];
  const enough = () => {
    const p = parseVoyager(docs, now).profile;
    return Boolean(p.yearsExperience !== undefined || p.skills?.length);
  };
  const steps: Array<{ step: string; run: () => Promise<Json[]> }> = [
    {
      step: 'profile-api',
      run: async () => [JSON.parse((await http.getWithHeaders(`https://www.linkedin.com/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(id!)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-93`, api)).text)],
    },
    {
      step: 'profile-page',
      run: async () => codeBlocks((await http.get(`https://www.linkedin.com/in/${encodeURIComponent(id!)}/`, { useSession: true, accept: 'text/html' })).text),
    },
  ];
  for (const s of steps) {
    if (enough()) break;
    try {
      const got = await s.run();
      docs.push(...got);
      diagnostics.push({ step: s.step, status: `${got.length} document(s)`, entityTypes: typeHistogram(got) });
    } catch (e) {
      rethrow(e);
      diagnostics.push({ step: s.step, status: e instanceof Error ? e.message : String(e) });
    }
  }
  return { imported: parseVoyager(docs, now, [`read from the LinkedIn account that owns the saved session (${id})`]), diagnostics };
}

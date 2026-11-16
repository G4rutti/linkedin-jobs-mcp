// Candidate profile: lets any user say who they are once, so searches drop
// titles that are out of reach and every posting gets a fit check.
import * as fs from 'fs';
import * as path from 'path';
import { configDir, ensureConfigDir } from './config.js';

export const profilePath = path.join(configDir, 'profile.json');

export const SENIORITY = ['intern', 'junior', 'mid', 'senior', 'lead'] as const;
export type Seniority = (typeof SENIORITY)[number];
export const LANG_LEVELS = ['none', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'native'] as const;
export type LangLevel = (typeof LANG_LEVELS)[number];

export interface Profile {
  seniority?: Seniority;
  yearsExperience?: number;
  skills?: string[]; // e.g. ["React", "TypeScript", "Node.js", "Python"]
  languages?: Record<string, LangLevel>; // ISO 639-1 -> level, e.g. { en: "C1", pt: "native" }
  needsVisa?: boolean; // true = needs sponsorship to work where the job is
  excludeTitle?: string[]; // extra words to always drop
  includeTitle?: string[]; // words to keep even if the seniority rule would drop them
}

export function loadProfile(): Profile | undefined {
  try {
    return fs.existsSync(profilePath) ? (JSON.parse(fs.readFileSync(profilePath, 'utf8')) as Profile) : undefined;
  } catch {
    return undefined;
  }
}

export function saveProfile(p: Profile): void {
  ensureConfigDir();
  fs.writeFileSync(profilePath, JSON.stringify(p, null, 2), { mode: 0o600 });
}

export function clearProfile(): boolean {
  if (!fs.existsSync(profilePath)) return false;
  fs.rmSync(profilePath);
  return true;
}

// Title words that are almost always out of reach for each level, in EN/DE/NL/PT/FR/ES.
const TOO_SENIOR = ['senior', 'sr', 'lead', 'principal', 'staff', 'head', 'director', 'architect', 'manager', 'vp', 'chief', 'cto'];
const TOO_JUNIOR = ['intern', 'internship', 'trainee', 'werkstudent', 'praktikum', 'praktikant', 'stage', 'stagiair', 'afstudeerstage', 'estágio', 'estagiário', 'stagiaire', 'apprentice', 'ausbildung'];
const SENIORITY_EXCLUDES: Record<Seniority, string[]> = {
  intern: TOO_SENIOR.concat(['medior', 'mid', 'experienced']),
  junior: TOO_SENIOR.concat(TOO_JUNIOR),
  mid: ['principal', 'staff', 'head', 'director', 'vp', 'chief', 'cto', ...TOO_JUNIOR],
  senior: ['junior', 'jr', 'graduate', ...TOO_JUNIOR],
  lead: ['junior', 'jr', 'graduate', 'medior', ...TOO_JUNIOR],
};

/** Words to drop from titles for this profile (seniority rule + extras - keeps). */
export function profileExcludes(p: Profile | undefined): string[] | undefined {
  if (!p) return undefined;
  const keep = new Set((p.includeTitle ?? []).map((w) => w.toLowerCase()));
  const words = [...(p.seniority ? SENIORITY_EXCLUDES[p.seniority] : []), ...(p.excludeTitle ?? [])]
    .map((w) => w.toLowerCase())
    .filter((w) => !keep.has(w));
  return words.length ? [...new Set(words)] : undefined;
}

// ── Fit check ────────────────────────────────────────────────────────────────

const LANGS: Record<string, { names: RegExp; stopwords: string[] }> = {
  de: { names: /\b(german|deutsch\w*)\b/i, stopwords: ['und', 'die', 'der', 'wir', 'mit', 'für', 'sie', 'ist', 'auf', 'du'] },
  nl: { names: /\b(dutch|nederlands\w*)\b/i, stopwords: ['en', 'het', 'de', 'een', 'wij', 'je', 'met', 'voor', 'van', 'naar'] },
  fr: { names: /\b(french|français|francais)\b/i, stopwords: ['et', 'les', 'des', 'nous', 'vous', 'pour', 'avec', 'une', 'sur', 'dans'] },
  es: { names: /\b(spanish|español|espanol|castellano)\b/i, stopwords: ['y', 'los', 'las', 'para', 'con', 'una', 'del', 'nuestro', 'somos', 'tu'] },
  pt: { names: /\b(portuguese|português|portugues)\b/i, stopwords: ['e', 'os', 'para', 'com', 'uma', 'você', 'nosso', 'são', 'não', 'na'] },
  it: { names: /\b(italian|italiano)\b/i, stopwords: ['e', 'il', 'per', 'con', 'una', 'del', 'della', 'siamo', 'nostro', 'che'] },
  en: { names: /\b(english|englisch|engels|inglês)\b/i, stopwords: ['and', 'the', 'we', 'with', 'for', 'you', 'our', 'is', 'are', 'to'] },
};
const LEVEL_WORDS: Array<[RegExp, LangLevel]> = [
  [/\b(native|mother tongue|muttersprach\w*|moedertaal|nativo)\b/i, 'native'],
  [/\bC2\b|verhandlungssicher|business fluent|full professional/i, 'C2'],
  [/\bC1\b|fluent|fließend|fliessend|vloeiend|fluente|excellent|sehr gut/i, 'C1'],
  [/\bB2\b|good command|gute|goed|professional working/i, 'B2'],
  [/\bB1\b|basic|grundkenntnisse|intermediate/i, 'B1'],
];
const rank = (l: LangLevel | undefined) => LANG_LEVELS.indexOf(l ?? 'none');

/** Main language the ad is written in, by stopword counts. */
export function adLanguage(text: string): string | undefined {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < 30) return undefined;
  let best: [string, number] = ['', 0];
  for (const [code, { stopwords }] of Object.entries(LANGS)) {
    const set = new Set(stopwords);
    const n = words.filter((w) => set.has(w)).length;
    if (n > best[1]) best = [code, n];
  }
  return best[1] >= 5 ? best[0] : undefined;
}

/** Languages the ad asks for, with the level when it says one. */
export function requiredLanguages(text: string): Record<string, LangLevel | 'unspecified'> {
  const out: Record<string, LangLevel | 'unspecified'> = {};
  const sentences = text.split(/(?<=[.!?•;:\n])\s+|\s{2,}/);
  for (const s of sentences) {
    for (const [code, { names }] of Object.entries(LANGS)) {
      if (!names.test(s)) continue;
      // "Nice to have German" / "is a plus" is not a requirement.
      if (/nice[- ]to[- ]have|is a plus|a plus|bonus|von vorteil|pré|preferred|wünschenswert|pluspunt/i.test(s)) continue;
      const level = LEVEL_WORDS.find(([re]) => re.test(s))?.[1];
      const prev = out[code];
      if (!prev || prev === 'unspecified' || (level && rank(level) > rank(prev))) out[code] = level ?? prev ?? 'unspecified';
    }
  }
  return out;
}

/** Highest "N+ years" the ad asks for (EN/DE/NL/PT/FR/ES), ignoring absurd numbers. */
export function requiredYears(text: string): number | undefined {
  const re = /(?:≥|at least|minimum(?: of)?|mindestens|minimaal|pelo menos|au moins)?\s*(\d{1,2})\s*\+?\s*(?:-\s*\d{1,2}\s*)?(?:years?|yrs?|jahre?n?|jaar|anos|ans|años)\b/gi;
  let max: number | undefined;
  for (const m of text.matchAll(re)) {
    const n = Number(m[1]);
    // "30 days", "founded 10 years ago" style noise: keep plausible requirements only.
    const around = text.slice(Math.max(0, m.index! - 60), m.index! + m[0].length + 60).toLowerCase();
    if (n < 1 || n > 15) continue;
    if (!/experience|erfahrung|ervaring|experiência|expérience|experiencia|professional|berufs|track record/.test(around)) continue;
    max = Math.max(max ?? 0, n);
  }
  return max;
}

export interface Fit {
  verdict: 'good' | 'stretch' | 'blocked' | 'unknown';
  blockers: string[];
  stretches: string[];
  pluses: string[];
  yearsRequired?: number;
  languagesRequired: Record<string, string>;
  adLanguage?: string;
  skillsMatched: string[];
}

export function analyzeFit(
  job: { title: string; description: string; criteria: Record<string, string>; visaMentions: string[]; visaNegatives: string[] },
  p: Profile,
): Fit {
  const blockers: string[] = [];
  const stretches: string[] = [];
  const pluses: string[] = [];

  const years = requiredYears(job.description);
  if (years !== undefined && p.yearsExperience !== undefined) {
    const gap = years - p.yearsExperience;
    if (gap >= 3) blockers.push(`asks ${years}+ years, you have ${p.yearsExperience}`);
    else if (gap >= 1) stretches.push(`asks ${years}+ years, you have ${p.yearsExperience}`);
  }

  const langs = requiredLanguages(job.description);
  const lang = adLanguage(job.description);
  if (lang && lang !== 'en' && !langs[lang]) langs[lang] = 'unspecified';
  if (p.languages) {
    for (const [code, need] of Object.entries(langs)) {
      const have = p.languages[code] ?? 'none';
      const needRank = need === 'unspecified' ? rank('B2') : rank(need);
      const label = need === 'unspecified' ? `${code} (level not stated${code === lang ? ', ad is written in it' : ''})` : `${code} ${need}`;
      if (rank(have) >= needRank) continue;
      if (rank(have) <= rank('A2') || need === 'C2' || need === 'native') blockers.push(`needs ${label}, you have ${have}`);
      else stretches.push(`needs ${label}, you have ${have}`);
    }
  }

  if (p.needsVisa) {
    if (job.visaNegatives.length) blockers.push(`ad rules out sponsorship: "${job.visaNegatives[0]}"`);
    else if (job.visaMentions.length) pluses.push(`mentions ${job.visaMentions.join(', ')}`);
    else stretches.push('no word on visa/relocation: ask before investing time');
  }

  const level = (job.criteria['Seniority level'] ?? '').toLowerCase();
  if (p.seniority && /^(intern|junior)$/.test(p.seniority) && /mid-senior|director|executive/.test(level))
    stretches.push(`LinkedIn tags it "${job.criteria['Seniority level']}"`);

  const hay = `${job.title} ${job.description}`.toLowerCase();
  const skillsMatched = (p.skills ?? []).filter((s) => {
    const esc = s.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, 'u').test(hay);
  });
  if (p.skills?.length) {
    if (skillsMatched.length) pluses.push(`stack overlap: ${skillsMatched.join(', ')}`);
    else stretches.push('none of your skills appear in the ad');
  }

  const verdict = blockers.length ? 'blocked' : stretches.length ? 'stretch' : pluses.length ? 'good' : 'unknown';
  return { verdict, blockers, stretches, pluses, yearsRequired: years, languagesRequired: langs, adLanguage: lang, skillsMatched };
}

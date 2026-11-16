import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adLanguage, analyzeFit, profileExcludes, requiredLanguages, requiredYears, type Profile } from './profile.js';
import { titleExcluded, visaSignals } from './linkedin.js';

const junior: Profile = { seniority: 'junior', yearsExperience: 1, skills: ['React', 'TypeScript', 'Node.js'], languages: { en: 'C1', pt: 'native', de: 'none', nl: 'none' }, needsVisa: true };

// Excerpts of real postings seen while testing.
const INSTAFFO =
  'Anforderungen Bitte beachte, dass für diese Stelle eine Arbeitserlaubnis für Deutschland erforderlich ist. Sprache: Deutsch - Verhandlungssicher (C2) Must-Haves ≥ 3 Jahre professionelle Web-Entwicklungs­erfahrung – dein Git-Log spricht für dich. Tiefe Kenntnisse in React, TypeScript, Java, JavaScript und Spring Boot. Wir entwickeln SaaS-Produkte und du arbeitest mit uns für die Zukunft der Plattform auf der wir bauen.';
const NAVVIS =
  'You bring 3+ years of experience in software engineering, with a track record of delivering complex systems. Frontend experience with Typescript and either Angular, React or Vue.js. We offer full visa and relocation support for international candidates. We offer 30 days of paid time off per year.';
const VCSW =
  'Je hebt al kleine webapplicaties gebouwd met een backendtaal. Nederlands en Engels op minimaal B2-niveau. We bouwen met Laravel, React en Tailwind voor de werkgevers van het land en je werkt met een team van developers in een cultuur van leren voor iedereen die het wil.';

test('years: counts experience, ignores vacation days', () => {
  assert.equal(requiredYears(INSTAFFO), 3);
  assert.equal(requiredYears(NAVVIS), 3);
  assert.equal(requiredYears('30 days of paid time off. Founded 12 years ago.'), undefined);
});

test('languages: level and ad language are detected', () => {
  assert.equal(requiredLanguages(INSTAFFO).de, 'C2');
  assert.equal(requiredLanguages(VCSW).nl, 'B2');
  assert.equal(adLanguage(INSTAFFO), 'de');
  assert.equal(adLanguage(NAVVIS), 'en');
  assert.deepEqual(requiredLanguages('German is a plus.'), {});
});

test('visa: work-permit-required is a negative, relocation support is a mention', () => {
  assert.ok(visaSignals(INSTAFFO).negatives.length > 0);
  assert.ok(visaSignals(NAVVIS).mentions.some((m) => /relocation support|visa/.test(m)));
  assert.equal(visaSignals('Valid work permit required.').mentions.length, 0);
});

test('fit: Instaffo is blocked, NavVis is a stretch, VCSW blocked on Dutch', () => {
  const job = (description: string, title = 'Full Stack Developer') => ({ title, description, criteria: {}, ...((v) => ({ visaMentions: v.mentions, visaNegatives: v.negatives }))(visaSignals(description)) });
  const a = analyzeFit(job(INSTAFFO), junior);
  assert.equal(a.verdict, 'blocked');
  assert.ok(a.blockers.some((b) => /de C2/.test(b)));
  assert.ok(a.blockers.some((b) => /sponsorship/.test(b)));
  const b = analyzeFit(job(NAVVIS), junior);
  assert.equal(b.verdict, 'stretch');
  assert.ok(b.pluses.some((p) => /React/.test(p)));
  assert.equal(analyzeFit(job(VCSW), junior).verdict, 'blocked');
});

test('seniority drives title filtering, includeTitle overrides', () => {
  const words = profileExcludes(junior)!;
  assert.equal(titleExcluded('Senior Full Stack Engineer', words), true);
  assert.equal(titleExcluded('Werkstudent Softwareentwicklung', words), true);
  assert.equal(titleExcluded('Junior Full-stack Developer', words), false);
  assert.equal(titleExcluded('Senior Frontend Developer', profileExcludes({ seniority: 'junior', includeTitle: ['senior'] })), false);
  assert.equal(profileExcludes(undefined), undefined);
  assert.equal(titleExcluded('Junior React Developer', profileExcludes({ seniority: 'senior' })), true);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeBlocks, importFromText, monthsUnion, parseLanguages, parseRangesFromLines, parseVoyager } from './profile-import.js';

const NOW = { y: 2026, m: 11 };

const CV = `JANE DOE
Software Engineering student and full-stack developer.
PROFESSIONAL EXPERIENCE
Junior Full Stack Developer — Client: Acme Retail Jan 2026 – Present
Consultancy · Remote
• Built things with React and Python.
Junior Full Stack Developer — Client: Globex Sep 2025 – Jan 2026
Frontend Intern Jun 2024 – Sep 2025
SELECTED AI PROJECTS
side-project — Agentic experiment, Jan 2025 – Mar 2025
EDUCATION
B.Sc. in Software Engineering · GPA 8.6 / 10 2024 – Dec 2027 (Expected)
Systems Development Technician 2021 – 2023
TECHNICAL SKILLS
AI: LLMs, LangGraph, RAG pipelines, MCP, OpenAI / Claude / Gemini / Mistral APIs
Backend: Python, FastAPI, Node.js, REST APIs, PostgreSQL, Redis
Frontend: React, Next.js, TypeScript, Tailwind CSS, shadcn/ui
Cloud & DevOps: AWS (EC2, S3, VPC), Docker, Git/GitHub · Keycloak (OIDC/JWT), RBAC
Languages: Portuguese (native), English (C1, fluent)`;

const LINKEDIN_PDF = `Contact
Top Skills
TypeScript
Node.js
PostgreSQL
Languages
English (Full Professional)
Portuguese (Native or Bilingual)
German (Elementary)
Jane Doe
Senior Software Engineer at Initech
Experience
Initech
Senior Software Engineer
March 2022 - Present (4 years 9 months)
Hooli
Software Engineer
June 2018 - February 2022 (3 years 9 months)
Education
State University
Bachelor of Science - BS, Computer Science
2014 - 2018`;

test('date ranges: months overlap once, education and future dates are not experience', () => {
  const ranges = parseRangesFromLines(['Dev Jun 2024 – Sep 2025', 'Dev Sep 2025 – Jan 2026', 'Dev Jan 2026 – Present']);
  assert.equal(ranges.length, 3);
  assert.equal(monthsUnion(ranges, NOW), 30); // Jun 2024 .. Nov 2026, inclusive
  assert.equal(monthsUnion([{ start: { y: 2027, m: 1 }, end: { y: 2027, m: 12 } }], NOW), 0);
  assert.equal(monthsUnion([{ start: { y: 2020 }, end: { y: 2020 } }], NOW), 12);
});

test('CV text: years, seniority from the current title, skills and languages', () => {
  const r = importFromText(CV, NOW);
  assert.equal(r.profile.seniority, 'junior');
  // Jun 2024..Nov 2026 plus Jan-Mar 2025 inside it: 30 months
  assert.equal(r.profile.yearsExperience, 2.5);
  assert.deepEqual(r.profile.languages, { pt: 'native', en: 'C1' });
  const skills = r.profile.skills!;
  for (const s of ['LangGraph', 'FastAPI', 'React', 'TypeScript', 'AWS', 'Docker', 'Keycloak', 'Claude', 'Gemini', 'shadcn/ui']) assert.ok(skills.includes(s), s);
  assert.ok(!skills.some((s) => /portuguese|english|ec2/i.test(s)), 'languages and parenthesised detail are not skills');
  assert.ok(!r.positions.some((p) => p.from.startsWith('2021') || p.to.startsWith('2027')), 'education is not experience');
});

test('LinkedIn "Save to PDF" text: titles on the line above the date, CEFR from proficiency words', () => {
  const r = importFromText(LINKEDIN_PDF, NOW);
  assert.equal(r.profile.seniority, 'senior');
  assert.equal(r.profile.yearsExperience, 8.5); // Jun 2018..Nov 2026 = 102 months, no gap between the two jobs
  assert.deepEqual(r.profile.languages, { en: 'C1', pt: 'native', de: 'A2' });
  assert.deepEqual(r.profile.skills, ['TypeScript', 'Node.js', 'PostgreSQL']);
  assert.equal(r.positions[0].title, 'Senior Software Engineer');
});

test('no skills section: falls back to known technologies and says so', () => {
  const r = importFromText('Experience\nBackend dev Mar 2023 - Present\nWe used Python, Docker and PostgreSQL daily, plus the rest of the stack.', NOW);
  assert.deepEqual(r.profile.skills, ['Python', 'PostgreSQL', 'Docker']);
  assert.ok(r.notes.some((n) => /known technologies/.test(n)));
});

test('languages: levels from CEFR, words and PT/DE names; no level means skipped, never guessed', () => {
  const { languages, skipped } = parseLanguages(['Inglês (avançado), Alemão (B1), Spanish', 'Dutch: basic']);
  assert.deepEqual(languages, { en: 'C1', de: 'B1', nl: 'A2' });
  assert.deepEqual(skipped, ['Spanish (no level stated)']);
});

test('LinkedIn normalized JSON: positions, skills and languages from included entities', () => {
  const doc = {
    data: {},
    included: [
      { $type: 'com.linkedin.voyager.dash.identity.profile.Position', title: 'Junior Developer', dateRange: { start: { year: 2024, month: 6 } } },
      { $type: 'com.linkedin.voyager.dash.identity.profile.Skill', name: 'React' },
      { $type: 'com.linkedin.voyager.dash.identity.profile.Skill', name: 'react' },
      { $type: 'com.linkedin.voyager.dash.identity.profile.Language', name: 'English', proficiency: 'FULL_PROFESSIONAL' },
      { $type: 'com.linkedin.voyager.dash.identity.profile.Language', name: 'Portuguese', proficiency: 'NATIVE_OR_BILINGUAL' },
      { $type: 'com.linkedin.voyager.dash.identity.profile.Education', schoolName: 'Nowhere' },
    ],
  };
  const r = parseVoyager([doc], NOW);
  assert.deepEqual(r.profile, { yearsExperience: 2.5, seniority: 'junior', skills: ['React'], languages: { en: 'C1', pt: 'native' } });
});

test('page <code> blocks: JSON is decoded, non-JSON is ignored', () => {
  const html = '<code id="a">{&quot;included&quot;:[{&quot;$type&quot;:&quot;x.Skill&quot;,&quot;name&quot;:&quot;Go&quot;}]}</code><code>not json</code>';
  const docs = codeBlocks(html);
  assert.equal(docs.length, 1);
  assert.deepEqual(parseVoyager(docs, NOW).profile.skills, ['Go']);
});

# linkedin-jobs-mcp

Read-only [MCP](https://modelcontextprotocol.io) server for **LinkedIn job hunting**: search, full postings, jobs posted in the last minutes, saved searches that only report what is new, and a visa-sponsorship check on each ad.

Login works like [familysearch-mcp](https://github.com/G4rutti/familysearch-mcp): a browser window opens, you sign in by hand, and the session is stored on your machine. Job functions and safety rules are adapted from [eliasbiondo/linkedin-mcp-server](https://github.com/eliasbiondo/linkedin-mcp-server).

## Tools

| Tool | What it does |
| --- | --- |
| `login-with-browser` | Opens Brave/Chrome with a separate profile; you log in; cookies go to `~/.linkedin-jobs-mcp/config.json` (0600). |
| `session-status` / `logout` | Check or delete the saved session. |
| `search-jobs` | Filters: `location`, `datePosted` (past_hour … past_month), `jobType`, `experienceLevel`, `workType`, `easyApply`, `under10Applicants`, `excludeTitle`, `sortBy`, `maxPages` (1-10). |
| `get-job-details` | Description, criteria, applicants, `visaMentions` / `visaNegatives`. Logged in: exact publish time, applicant count, Easy Apply, whether you already applied. With a profile: a `fit` check. |
| `fresh-jobs` | Jobs posted in the last N minutes (default 60) for up to 5 keyword sets at once, newest first, each flagged `isNew`. |
| `save-search` / `list-saved-searches` / `delete-saved-search` | Keep up to 30 named searches. |
| `set-profile` / `get-profile` / `clear-profile` | Who you are: seniority, years, skills, languages with CEFR level, whether you need a visa. Stored in `~/.linkedin-jobs-mcp/profile.json`. |
| `import-profile` | Fills the profile from the real thing. No arguments: reads **your own** LinkedIn profile through the saved session. With `text`: parses a CV or LinkedIn "Save to PDF" text. |
| `get-person-profile` | Reads a LinkedIn profile **by sections**. Always: name, headline, location, followers, connections (own), about, photo, skills, certifications. Optional `sections`: `experience`, `education`, `contact_info`, `interests` (followed companies and groups), `honors`, `languages`, `posts`, `recommendations` (received and given). No `username` = your own profile. |
| `get-company-profile` | Reads a company page. Always: overview, website, industry, size, headquarters, specialties, followers, logo. Optional `sections`: `posts` (with reactions and comments), `jobs` (open positions). |
| `triage-jobs` | Opens up to 10 postings and ranks them `good` / `stretch` / `unknown` / `blocked` against your profile, with the reasons. |
| `check-saved-searches` | Runs saved searches over the time since the last check and returns only jobs never seen before. |

## Profile and fit check

Run `import-profile` and the server builds the profile for you, or tell it by hand with `set-profile`, for example:

```json
{ "seniority": "junior", "yearsExperience": 1, "skills": ["React", "TypeScript", "Node.js"],
  "languages": { "en": "C1", "pt": "native", "de": "none" }, "needsVisa": true }
```

- **Title filter.** Your seniority picks the title words that get dropped from every search: a junior never sees "Senior", "Lead", "Staff" or "Werkstudent"; a senior never sees "Junior" or "Intern". Words are matched in EN, DE, NL, PT, FR and ES. Add your own with `excludeTitle`, rescue words with `includeTitle`, or pass `excludeTitle: []` on one call to switch it off.
- **Fit check.** `get-job-details` and `triage-jobs` read the ad and report:
  - years of experience asked (`3+ years`, `≥ 3 Jahre`, `minimaal 2 jaar`…) against yours;
  - languages asked, with CEFR level (`Deutsch verhandlungssicher` = C2), plus the language the ad is written in, against yours;
  - visa: ads that rule it out (`work permit required`, `Arbeitserlaubnis … erforderlich`) are `blocked`, ads that offer it are a plus, silence is flagged;
  - which of your skills appear in the ad.

### Importing the profile

- **`import-profile` (no arguments)** reads the profile of the account that owns the saved login: jobs with dates, skills and languages. The account comes from LinkedIn's `/me`, never from an input, so it cannot read anybody else's profile. It uses LinkedIn's internal web API, which is undocumented and can change without notice, and reading it with your own session is a grey area of LinkedIn's terms: it is opt-in and only runs when you call it. If it comes back empty, use the text import.
- **`import-profile` with `text`** takes a CV or the text of LinkedIn's "Save to PDF" and needs no login. Years of experience are the distinct months covered by your jobs (overlaps counted once; education, awards and future dates ignored), seniority comes from your current job title (or from the years if the title says nothing), skills come from the "Skills" section, and languages need an explicit level (`English (C1)`, `Portuguese (Native or Bilingual)`) or they are skipped, never guessed.
- `needsVisa` is never imported, a profile cannot know it: set it with `set-profile`.
- It saves by default and returns what it understood (`positions`, `notes`). Pass `save: false` to preview.

It is a heuristic from the ad text, not a verdict: read the `blockers` before trusting a `blocked`.

## Search tips

`keywords` takes LinkedIn Boolean: `AND`, `OR`, `NOT` in uppercase, "straight quotes" for exact phrases and parentheses to group. Precedence is quotes > () > NOT > AND > OR, so always wrap OR lists in parentheses. Wildcards (`*`) and `+`/`-` are not supported. The server fixes curly quotes and lowercase operators on its own and reports what it changed in `warnings`.

Filters on `search-jobs`, `fresh-jobs` and `save-search`:

- `under10Applicants`: LinkedIn's "Under 10 applicants" filter, for applying while you are still early.
- `excludeTitle`: drops jobs whose title has any of the given words, e.g. `["manager", "sap"]`. Without it, the words come from your profile. LinkedIn tends to ignore `NOT` in complex queries, so this filter is the reliable way to exclude titles.

Visa: search for `("visa sponsorship" OR "relocation")`, never the bare word "sponsorship". A keyword hit is not proof, so check `visaMentions` / `visaNegatives` in `get-job-details`.

## Install

### Claude Code (npx, no clone)

```bash
claude mcp add linkedin-jobs --scope user -- npx -y github:G4rutti/linkedin-jobs-mcp
```

Optional login (needed only for the logged-in extras in `get-job-details`):

```bash
npx -y github:G4rutti/linkedin-jobs-mcp --login
```

Then run `/mcp` inside Claude Code to check it is connected. You can also call the `login-with-browser` tool from the chat.

### Claude Desktop / Cursor / other MCP clients

```json
{
  "mcpServers": {
    "linkedin-jobs": {
      "command": "npx",
      "args": ["-y", "github:G4rutti/linkedin-jobs-mcp"]
    }
  }
}
```

### From source

```bash
git clone https://github.com/G4rutti/linkedin-jobs-mcp && cd linkedin-jobs-mcp
npm install && npm run build
npm run login   # optional
claude mcp add linkedin-jobs --scope user -- node "$(pwd)/build/index.js"
```

Requirements: Node 18+. Playwright does not download a browser: login uses the Brave/Chrome you already have (`LINKEDIN_BROWSER_PATH` to override). The first `npx` run takes a bit longer because it installs and compiles the package.

### Environment variables

| Variable | Default | What it does |
| --- | --- | --- |
| `LINKEDIN_MIN_INTERVAL_MS` | `4000` | Minimum gap between requests (jitter is added on top). |
| `LINKEDIN_BROWSER_PATH` | auto | Browser used by the login. |
| `LINKEDIN_JOBS_MCP_DIR` | `~/.linkedin-jobs-mcp` | Where the session and saved searches live. |

With Claude Code: `claude mcp add linkedin-jobs --scope user -e LINKEDIN_MIN_INTERVAL_MS=6000 -- npx -y github:G4rutti/linkedin-jobs-mcp`

## Safety

- **Read-only.** No apply, message, connect, save or post tools exist.
- **Search and job pages use LinkedIn's public endpoints without your cookies**, so scraping is not tied to your account. The session is only used for the logged-in extras in `get-job-details`.
- Cookies are only ever sent to `https://*.linkedin.com`; redirects are checked hop by hop.
- ~4 s between requests with jitter (`LINKEDIN_MIN_INTERVAL_MS`). On HTTP 429/999 or a security checkpoint: no retry, 15-minute pause.
- Job ids are validated as digits before any request.
- Details in [AUDIT.md](AUDIT.md).

Using an automated client on LinkedIn is against its User Agreement and can get an account restricted. Use your judgement.

## Tests

```bash
npm test
```

## License

MIT

## Reading profiles and companies

`get-person-profile` and `get-company-profile` call LinkedIn's internal web API with your saved session, one request at a time and with the same pacing and cooldown as the rest of the server. Each section fails on its own: if LinkedIn changes one endpoint, that section shows up under `errors` and the others still come back. Notes:

- Names, headlines and job text come in English when LinkedIn stores an English version; skill names come in the language of your account (common ones are mapped to English).
- People you follow are not exposed by the endpoint, only followed companies and groups. LinkedIn may return fewer skills than the profile lists (`skillsNote` says so).
- Reading other people's profiles with your session is a grey area of LinkedIn's terms and can get an account restricted. Use it lightly.

# linkedin-jobs-mcp

Read-only [MCP](https://modelcontextprotocol.io) server for **LinkedIn job hunting**: search, full postings, jobs posted in the last minutes, saved searches that only report what is new, and a visa-sponsorship check on each ad.

Login works like [familysearch-mcp](https://github.com/G4rutti/familysearch-mcp): a browser window opens, you sign in by hand, and the session is stored on your machine. Job functions and safety rules are adapted from [eliasbiondo/linkedin-mcp-server](https://github.com/eliasbiondo/linkedin-mcp-server).

## Tools

| Tool | What it does |
| --- | --- |
| `login-with-browser` | Opens Brave/Chrome with a separate profile; you log in; cookies go to `~/.linkedin-jobs-mcp/config.json` (0600). |
| `session-status` / `logout` | Check or delete the saved session. |
| `search-jobs` | Filters: `location`, `datePosted` (past_hour … past_month), `jobType`, `experienceLevel`, `workType`, `easyApply`, `sortBy`, `maxPages` (1-10). |
| `get-job-details` | Description, criteria, applicants, `visaMentions` / `visaNegatives`. Logged in: exact publish time, applicant count, Easy Apply, whether you already applied. |
| `fresh-jobs` | Jobs posted in the last N minutes (default 60) for up to 5 keyword sets at once, newest first, each flagged `isNew`. |
| `save-search` / `list-saved-searches` / `delete-saved-search` | Keep up to 30 named searches. |
| `check-saved-searches` | Runs saved searches over the time since the last check and returns only jobs never seen before. |

## Install

```bash
git clone https://github.com/G4rutti/linkedin-jobs-mcp && cd linkedin-jobs-mcp
npm install && npm run build
npm run login   # optional; needed only for logged-in extras
```

Playwright does not download a browser: it uses the Brave/Chrome you already have (`LINKEDIN_BROWSER_PATH` to override).

```json
{ "mcpServers": { "linkedin-jobs": { "command": "node", "args": ["/absolute/path/to/linkedin-jobs-mcp/build/index.js"] } } }
```

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

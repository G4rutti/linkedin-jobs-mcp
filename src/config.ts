import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Everything this server keeps lives in one folder, readable only by you.
export const configDir = process.env.LINKEDIN_JOBS_MCP_DIR || path.join(os.homedir(), '.linkedin-jobs-mcp');
export const configPath = path.join(configDir, 'config.json');
export const statePath = path.join(configDir, 'state.json');

export interface SessionConfig {
  cookies: string; // Cookie header for .linkedin.com, written by `npm run login`
  userName: string;
  savedAt: string;
}

export interface SavedSearch {
  name: string;
  keywords: string;
  location?: string;
  workType?: string;
  experienceLevel?: string;
  jobType?: string;
  easyApply?: boolean;
  under10Applicants?: boolean;
  excludeTitle?: string[];
  createdAt: string;
  lastCheckedAt?: string;
}

export interface WatchState {
  savedSearches: SavedSearch[];
  // job id -> first time this server saw it (ISO). Used for "new since last check".
  seen: Record<string, string>;
}

const MAX_SEEN = 5000;

export function ensureConfigDir(): void {
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(configDir, 0o700);
}

function readJson<T>(file: string, fallback: T): T {
  ensureConfigDir();
  if (!fs.existsSync(file)) return fallback;
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    console.error(`Could not read ${file}:`, error instanceof Error ? error.message : error);
    return fallback;
  }
}

function writeJson(file: string, data: unknown): void {
  ensureConfigDir();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

export const emptySession = (): SessionConfig => ({ cookies: '', userName: '', savedAt: '' });
export const loadSession = () => readJson<SessionConfig>(configPath, emptySession());
export const saveSession = (s: SessionConfig) => writeJson(configPath, s);
export function clearSession(): void {
  if (fs.existsSync(configPath)) fs.rmSync(configPath);
}

export const loadState = () => readJson<WatchState>(statePath, { savedSearches: [], seen: {} });
export function saveState(state: WatchState): void {
  const ids = Object.keys(state.seen);
  if (ids.length > MAX_SEEN) {
    const keep = ids.sort((a, b) => state.seen[b].localeCompare(state.seen[a])).slice(0, MAX_SEEN);
    state.seen = Object.fromEntries(keep.map((id) => [id, state.seen[id]]));
  }
  writeJson(statePath, state);
}

export function configMtimeMs(): number {
  try {
    return fs.statSync(configPath).mtimeMs;
  } catch {
    return 0;
  }
}

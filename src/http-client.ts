// HTTP client with the safety rules from familysearch-mcp:
// - the session cookie only ever goes to https://*.linkedin.com
// - redirects are followed by hand and checked hop by hop
// - one request at a time, ~4 s apart with jitter
// - on a rate limit or a security checkpoint: no retry, pause 15 min
//   (the pause is saved to disk, so restarting the server does not lift it)
import type { BlockInfo, RuntimeState } from './config.js';

export class RateLimitError extends Error {
  constructor(message: string, public waitSeconds: number) {
    super(message);
    this.name = 'RateLimitError';
  }
}
export class SessionExpiredError extends Error {
  name = 'SessionExpiredError';
}
export class BlockedUrlError extends Error {
  name = 'BlockedUrlError';
}

export function isLinkedInUrl(url: URL): boolean {
  return url.protocol === 'https:' && (url.hostname === 'linkedin.com' || url.hostname.endsWith('.linkedin.com'));
}

// From linkedin-mcp-server: URLs that mean "you are not (or no longer) logged in" or "prove you are human".
const AUTH_BLOCKERS = ['/login', '/authwall', '/checkpoint', '/challenge', '/uas/login', '/uas/consumer-email-challenge'];
const SECURITY_BLOCKERS = ['/checkpoint', '/challenge'];

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export interface ClientOptions {
  getCookies: () => string;
  minIntervalMs?: number;
  jitterFactor?: number;
  cooldownMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  loadRuntime?: () => RuntimeState;
  saveRuntime?: (r: RuntimeState) => void;
}

const STRIKE_WINDOW_MS = 90 * 60 * 1000;
const MAX_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class LinkedInHttpClient {
  private minIntervalMs: number;
  private jitterFactor: number;
  private cooldownMs: number;
  private fetchImpl: typeof fetch;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  private queue: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;
  private cooldownUntil = 0;
  private cooldownReason = '';
  lastBlock?: BlockInfo;
  strikes = 0;
  requestCount = 0;

  constructor(private opts: ClientOptions) {
    this.minIntervalMs = opts.minIntervalMs ?? Number(process.env.LINKEDIN_MIN_INTERVAL_MS || 4000);
    this.jitterFactor = opts.jitterFactor ?? 0.5;
    this.cooldownMs = opts.cooldownMs ?? 15 * 60 * 1000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
    try {
      const saved = opts.loadRuntime?.();
      if (saved) {
        this.cooldownUntil = saved.cooldownUntil || 0;
        this.cooldownReason = saved.cooldownReason || '';
        this.lastBlock = saved.lastBlock;
        this.strikes = saved.strikes ?? 0;
      }
    } catch {
      // No saved state: start clean.
    }
  }

  cookieHeader(): string {
    return this.opts.getCookies();
  }

  hasSession(): boolean {
    return /(?:^|;\s*)li_at=/.test(this.opts.getCookies());
  }

  cooldownRemainingSeconds(): number {
    return Math.max(0, Math.ceil((this.cooldownUntil - this.now()) / 1000));
  }

  private startCooldown(reason: string, url: URL, withSession: boolean): never {
    // Real use showed LinkedIn blocking again within minutes of a 15 min pause ended,
    // so a block soon after the previous one doubles the pause (15, 30, 60, then 2 h).
    const previousAt = this.lastBlock ? Date.parse(this.lastBlock.at) : NaN;
    const repeated = Number.isFinite(previousAt) && this.now() - previousAt < STRIKE_WINDOW_MS;
    this.strikes = repeated ? this.strikes + 1 : 1;
    const pauseMs = Math.min(this.cooldownMs * 2 ** (this.strikes - 1), MAX_COOLDOWN_MS);
    this.cooldownUntil = this.now() + pauseMs;
    this.cooldownReason = reason;
    this.lastBlock = { at: new Date(this.now()).toISOString(), reason, path: url.pathname, withSession };
    try {
      this.opts.saveRuntime?.({ cooldownUntil: this.cooldownUntil, cooldownReason: reason, lastBlock: this.lastBlock, strikes: this.strikes });
    } catch {
      // The in-memory pause still applies.
    }
    throw new RateLimitError(
      `LinkedIn ${reason}. Paused for ${Math.round(pauseMs / 60000)} min to protect your account${this.strikes > 1 ? ` (block ${this.strikes} in a row, so the pause grows)` : ''}; do not retry before that.`,
      Math.round(pauseMs / 1000),
    );
  }

  private async throttle(): Promise<void> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((r) => (release = r));
    await previous;
    try {
      const interval = this.minIntervalMs * (1 + this.jitterFactor * Math.random());
      const wait = this.lastRequestAt + interval - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastRequestAt = this.now();
    } finally {
      release();
    }
  }

  /** GET a LinkedIn URL. `useSession` attaches your cookies (only if a session exists). */
  async getWithHeaders(rawUrl: string, extraHeaders: Record<string, string>) {
    if (!this.hasSession()) throw new SessionExpiredError('Not logged in. Run login-with-browser.');
    return this.get(rawUrl, { useSession: true, accept: extraHeaders.accept ?? 'application/json', extraHeaders });
  }

  async get(
    rawUrl: string,
    { useSession = true, accept = 'text/html', extraHeaders = {} as Record<string, string> } = {},
  ): Promise<{ status: number; url: string; text: string }> {
    let url = new URL(rawUrl);
    if (!isLinkedInUrl(url)) throw new BlockedUrlError(`Refusing to request a non-LinkedIn URL: ${url.origin}`);

    const remaining = this.cooldownRemainingSeconds();
    if (remaining > 0) {
      throw new RateLimitError(`Paused after LinkedIn ${this.cooldownReason}; ${remaining}s remaining.`, remaining);
    }

    await this.throttle();
    const cookies = useSession && this.hasSession() ? this.opts.getCookies() : '';

    // Every hop is a real request: throttle each one, and stop at the first
    // repeated URL instead of walking a redirect loop with the session cookie.
    const chain: string[] = [url.pathname];
    const visited = new Set<string>([url.toString()]);
    for (let hop = 0; hop <= 5; hop++) {
      if (hop > 0) await this.throttle();
      this.requestCount++;
      const headers: Record<string, string> = {
        'user-agent': USER_AGENT,
        accept,
        'accept-language': 'en-US,en;q=0.9,pt-BR;q=0.8',
      };
      for (const [k, v] of Object.entries(extraHeaders)) if (k !== 'accept') headers[k.toLowerCase()] = v;
      if (cookies) headers.cookie = cookies;
      const res = await this.fetchImpl(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(25000) });

      if (res.status === 429 || res.status === 999) this.startCooldown(`rate limit (HTTP ${res.status})`, url, !!cookies);

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) throw new Error(`Redirect without location from ${url.pathname}`);
        const next = new URL(location, url);
        if (!isLinkedInUrl(next)) throw new BlockedUrlError(`LinkedIn redirected off linkedin.com (${next.origin}); stopped.`);
        if (SECURITY_BLOCKERS.some((p) => next.pathname.startsWith(p))) this.startCooldown('security checkpoint', next, !!cookies);
        if (AUTH_BLOCKERS.some((p) => next.pathname.startsWith(p))) {
          throw new SessionExpiredError(
            cookies
              ? 'LinkedIn session expired or was rejected. Run login-with-browser again.'
              : 'LinkedIn requires login for this page. Run login-with-browser.',
          );
        }
        chain.push(next.pathname);
        if (visited.has(next.toString())) {
          throw new Error(`Redirect loop from LinkedIn (${chain.join(' -> ')}); stopped after ${hop + 1} request(s).`);
        }
        visited.add(next.toString());
        url = next;
        continue;
      }

      const text = await res.text();
      if (res.status === 404) return { status: 404, url: url.toString(), text: '' };
      if (!res.ok) throw new Error(`HTTP ${res.status} from LinkedIn (${url.pathname})`);
      return { status: res.status, url: url.toString(), text };
    }
    throw new Error(`Too many redirects from LinkedIn (${chain.join(' -> ')}).`);
  }
}

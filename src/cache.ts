// Small TTL cache. Optional persistence keeps it across MCP restarts, so a
// restarted server does not re-download what it already fetched minutes ago.
export interface CachePersistence<T> {
  load: () => Record<string, { at: number; value: T }>;
  save: (data: Record<string, { at: number; value: T }>) => void;
}

export class TtlCache<T> {
  private map = new Map<string, { at: number; value: T }>();
  hits = 0;
  misses = 0;

  constructor(
    private ttlMs: number,
    private max: number,
    private now: () => number = Date.now,
    private persist?: CachePersistence<T>,
  ) {
    if (persist) {
      try {
        const data = persist.load();
        const t = this.now();
        for (const [k, e] of Object.entries(data ?? {})) if (e && t - e.at <= ttlMs) this.map.set(k, e);
      } catch {
        // A broken cache file is never worth failing a request over.
      }
    }
  }

  get(key: string): { value: T; at: number } | undefined {
    const e = this.map.get(key);
    if (!e || this.now() - e.at > this.ttlMs) {
      if (e) this.map.delete(key);
      this.misses++;
      return undefined;
    }
    this.hits++;
    return e;
  }

  set(key: string, value: T): void {
    this.map.delete(key);
    this.map.set(key, { at: this.now(), value });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
    if (this.persist) {
      try {
        this.persist.save(Object.fromEntries(this.map));
      } catch (error) {
        console.error('Could not save cache:', error instanceof Error ? error.message : error);
      }
    }
  }

  stats() {
    return { entries: this.map.size, hits: this.hits, misses: this.misses };
  }
}

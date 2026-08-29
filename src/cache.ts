/**
 * A tiny TTL + LRU cache.
 *
 * Caching is the single most effective anti-ban measure in this project: a
 * cached profile costs zero upstream requests, and repeat lookups of the same
 * profile are the common case for any real caller.
 *
 * Deliberately in-memory and bounded. We are caching third-party personal
 * data, so it should be short-lived and non-durable; swapping in Redis would
 * mean writing that data to disk somewhere, which is a decision that deserves
 * to be made explicitly rather than inherited from a library default.
 */

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache<T> {
  private readonly map = new Map<string, Entry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 500,
  ) {}

  get(key: string): T | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    // Re-insert so Map iteration order approximates recency for eviction.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: T): void {
    if (this.ttlMs <= 0) return;
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  get size(): number {
    return this.map.size;
  }
}

/**
 * Serializes upstream profile fetches and enforces a minimum gap between them.
 *
 * This is where the "don't look like a bot" pacing lives. Note what it does
 * NOT do: it does not space out the individual section requests within one
 * profile. A browser fires those as a burst, and spacing them uniformly would
 * be less human, not more. The gap belongs BETWEEN profile views.
 *
 * Serializing also means concurrent API callers cannot multiply our upstream
 * request rate — ten simultaneous requests for ten profiles queue rather than
 * firing at once.
 */
export class UpstreamGate {
  private chain: Promise<unknown> = Promise.resolve();
  private lastStartedAt = 0;

  constructor(
    private readonly minIntervalMs: number,
    private readonly jitterMs: number,
  ) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      const wait = this.lastStartedAt === 0 ? 0 : this.lastStartedAt + this.delay() - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastStartedAt = Date.now();
      return task();
    });
    // Keep the chain alive even when a task rejects, or one failure would
    // permanently wedge every subsequent request.
    this.chain = next.catch(() => undefined);
    return next;
  }

  private delay(): number {
    return this.minIntervalMs + Math.random() * this.jitterMs;
  }
}

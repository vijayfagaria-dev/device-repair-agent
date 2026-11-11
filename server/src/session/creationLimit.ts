// Per-key sliding-window limit on new session creation (P1-T03; protocol.md §2: default 20 per IP per hour).
// In memory and per process: one Render instance runs at a time (D11), and a restart only resets the budget.
// The general HTTP rate limits come with P3-T02.

export interface CreationLimiterOptions {
  max: number;
  windowMs: number;
  now?: () => number;
}

export class CreationLimiter {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  /** Creation times per key, oldest first, at most `max` entries each. */
  readonly #hits = new Map<string, number[]>();
  #lastSweep = 0;

  constructor({ max, windowMs, now = Date.now }: CreationLimiterOptions) {
    if (!Number.isInteger(max) || max < 1) throw new RangeError("max must be a positive integer");
    if (!Number.isFinite(windowMs) || windowMs <= 0) throw new RangeError("windowMs must be positive");
    this.#max = max;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  /** Takes one slot for `key`. Returns false (and takes nothing) when the key has used its budget for the window. */
  tryAcquire(key: string): boolean {
    const now = this.#now();
    this.#sweep(now);
    const hits = this.#live(key, now);
    if (hits.length >= this.#max) return false;
    hits.push(now);
    this.#hits.set(key, hits);
    return true;
  }

  /** Gives back the most recent slot, when the acquire didn't end up creating anything (e.g. a concurrent insert won). */
  release(key: string): void {
    const hits = this.#hits.get(key);
    hits?.pop();
    if (hits?.length === 0) this.#hits.delete(key);
  }

  /** Number of keys currently tracked (for tests). */
  get size(): number {
    return this.#hits.size;
  }

  #live(key: string, now: number): number[] {
    const hits = this.#hits.get(key) ?? [];
    const firstLive = hits.findIndex((at) => now - at < this.#windowMs);
    return firstLive === -1 ? [] : firstLive === 0 ? hits : hits.slice(firstLive);
  }

  /** Drops expired keys at most once per window, so memory stays bounded by the keys active in one window. */
  #sweep(now: number): void {
    if (now - this.#lastSweep < this.#windowMs) return;
    this.#lastSweep = now;
    for (const [key, hits] of this.#hits) {
      const last = hits[hits.length - 1];
      if (last === undefined || now - last >= this.#windowMs) this.#hits.delete(key);
    }
  }
}

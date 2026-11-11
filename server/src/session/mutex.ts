// Per-key async mutex (D11): work for one session runs strictly one at a time inside this process. It is only the
// fast path: the `FOR UPDATE` session row lock taken first in every command transaction (D09) is what keeps commands
// ordered across two processes (a deploy overlap).

export class KeyedMutex {
  /** The tail of each key's queue; removed when the last holder releases, so idle keys cost nothing. */
  readonly #tails = new Map<string, Promise<void>>();

  /**
   * Runs `fn` once every earlier `run` for `key` has finished (FIFO). The lock is released before the returned promise
   * settles, so a caller that awaits `run` and then dispatches more work for the same key never waits on itself.
   */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => held);
    this.#tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }

  /** Keys with a holder or waiters (for tests and leak checks). */
  get size(): number {
    return this.#tails.size;
  }
}

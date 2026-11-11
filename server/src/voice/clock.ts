// The clock the call engine runs on: real timers in production, a manual clock in tests (call-scoped timers such as
// the silence reprompt live in memory, D16; they die with the call).
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** A clock tests advance by hand; timers fire in due order, each at its own `now`. */
export class ManualClock implements Clock {
  #now: number;
  #next = 1;
  readonly #timers = new Map<number, { at: number; fn: () => void }>();

  constructor(start = 1_700_000_000_000) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.#next++;
    this.#timers.set(id, { at: this.#now + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  /** Moves time forward, firing every timer due on the way (including ones those timers set). */
  advance(ms: number): void {
    const end = this.#now + ms;
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.#timers) if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry;
      if (!due) break;
      this.#timers.delete(due[0]);
      this.#now = due[1].at;
      due[1].fn();
    }
    this.#now = end;
  }

  get pending(): number {
    return this.#timers.size;
  }
}

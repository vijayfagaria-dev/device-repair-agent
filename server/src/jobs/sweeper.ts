// The timer sweeper (P3-T05, D16): fires persisted timers by dispatching TimerFired commands.
//
// No polling (rev 3, Neon compute budget, D09): it keeps the earliest known due time in memory and sleeps until then.
// - start(): one `SELECT min(due_at)`; overdue timers (the deadline passed while the server was down) fire at once.
// - notify(dueAt): the command processor reports every timer it commits; an earlier one moves the wake-up forward.
//   No query.
// - On waking: read a batch of due timers (FOR UPDATE SKIP LOCKED, so two instances reading at the same moment split
//   the batch; the row locks end with that short transaction, before firing), dispatch TimerFired for each, then read
//   the next due time and sleep again. Exactly-once comes from TimerFired itself: it re-checks the timer under the
//   session lock and removes it, so a second sweeper holding the same timer gets a no-op.
//   A timer stays in the table until TimerFired commits, so a crash mid-sweep loses nothing: it fires on the next boot.
// - A safety re-read runs at most once an hour (timers written by another instance, clock drift). That also keeps
//   every sleep far below setTimeout's ~24.8-day limit.
import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";
import { claimDueTimers, earliestTimerDueAt, type Timer } from "../db/repos/timers.js";
import { withTx } from "../db/tx.js";
import { type CommandProcessor, SessionNotFoundError } from "../session/commands.js";
import type { TimerFired } from "../session/handlers/timers.js";

export interface SweeperClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: SweeperClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref(); // never keeps the process alive on its own
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface SweeperOptions {
  pool: pg.Pool;
  processor: CommandProcessor;
  log: FastifyBaseLogger;
  clock?: SweeperClock;
  /** Timers claimed per batch. */
  batchSize?: number;
  /** The longest sleep: the safety re-read interval (default 1 hour). */
  maxSleepMs?: number;
  /** Wait before trying again after a database error. */
  retryDelayMs?: number;
}

export const SAFETY_REREAD_MS = 60 * 60 * 1000;

export class Sweeper {
  readonly #pool: pg.Pool;
  readonly #processor: CommandProcessor;
  readonly #log: FastifyBaseLogger;
  readonly #clock: SweeperClock;
  readonly #batchSize: number;
  readonly #maxSleepMs: number;
  readonly #retryDelayMs: number;
  /** The earliest due time this process knows of (ms), or null for none. */
  #nextDue: number | null = null;
  #handle: unknown = null;
  #wakeAt: number | null = null;
  #sweeping: Promise<void> | null = null;
  #sweepAgain = false;
  #stopped = true;
  /**
   * The min(due_at) reads in flight, each with the earliest notify() received meanwhile. A read's snapshot can predate
   * a timer committed (and notified) while it runs, so its result is combined with those notifications instead of
   * overwriting them (else that timer would wait for the hourly re-read).
   */
  readonly #reads = new Set<{ notified: number | null }>();

  constructor(options: SweeperOptions) {
    this.#pool = options.pool;
    this.#processor = options.processor;
    this.#log = options.log;
    this.#clock = options.clock ?? realClock;
    this.#batchSize = options.batchSize ?? 50;
    this.#maxSleepMs = options.maxSleepMs ?? SAFETY_REREAD_MS;
    this.#retryDelayMs = options.retryDelayMs ?? 30_000;
  }

  /** Reads the earliest due time once and schedules the first wake-up (immediately if a timer is already overdue). */
  async start(): Promise<void> {
    this.#stopped = false;
    this.#nextDue = await this.#readNextDue();
    this.#schedule();
  }

  /** A command committed a timer due at `dueAt`: wake up earlier if needed. Never queries. */
  notify(dueAt: Date): void {
    const due = dueAt.getTime();
    for (const read of this.#reads) read.notified = earlier(read.notified, due);
    if (this.#nextDue !== null && this.#nextDue <= due) return;
    this.#nextDue = due;
    if (!this.#stopped) this.#schedule();
  }

  /** Stops scheduling and waits for a sweep in progress. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#cancelWake();
    await this.#sweeping;
  }

  /** Resolves when the sweep in progress (if any) is done; never starts one. */
  async settled(): Promise<void> {
    while (this.#sweeping) await this.#sweeping;
  }

  /** Runs one sweep now (also what a wake-up runs); resolves when it and any sweep it queued are done. */
  async sweep(): Promise<void> {
    if (this.#sweeping) {
      this.#sweepAgain = true;
      return this.#sweeping;
    }
    this.#sweeping = this.#run().finally(() => {
      this.#sweeping = null;
    });
    return this.#sweeping;
  }

  async #run(): Promise<void> {
    do {
      this.#sweepAgain = false;
      try {
        const failed = await this.#fireDue();
        this.#nextDue = await this.#readNextDue();
        // A timer whose command failed is still due: come back after the retry delay, not at once (no busy loop).
        this.#schedule(failed > 0 ? this.#retryDelayMs : undefined);
      } catch (err) {
        this.#log.error({ code: (err as { code?: string }).code, message: (err as Error).message }, "timer sweep failed; retrying");
        this.#schedule(this.#retryDelayMs);
      }
    } while (this.#sweepAgain && !this.#stopped);
  }

  /** The earliest due time: the database's, or an earlier one notified while the query ran. */
  async #readNextDue(): Promise<number | null> {
    const read = { notified: null as number | null };
    this.#reads.add(read);
    try {
      const earliest = await earliestTimerDueAt(this.#pool);
      return earlier(earliest?.getTime() ?? null, read.notified);
    } finally {
      this.#reads.delete(read);
    }
  }

  /** Fires every due timer, batch by batch; returns how many failed (they stay due and are retried later). */
  async #fireDue(): Promise<number> {
    let failed = 0;
    for (;;) {
      const now = new Date(this.#clock.now());
      const due = await withTx(this.#pool, (tx) => claimDueTimers(tx, { now, limit: this.#batchSize }));
      for (const timer of due) {
        // Shutting down: leave the rest for the next boot (they stay in the table) instead of delaying exit.
        if (this.#stopped) return failed;
        if (!(await this.#fire(timer))) failed += 1;
      }
      // A failed timer would be read again at once; stop and let the retry delay pass first.
      if (due.length < this.#batchSize || failed > 0 || this.#stopped) return failed;
    }
  }

  /**
   * Dispatches TimerFired for one timer. A failure is logged and doesn't stop the others: one session whose command
   * keeps failing must not hold up every other session's deadlines.
   */
  async #fire(timer: Timer): Promise<boolean> {
    const command: TimerFired = { type: "TimerFired", kind: timer.kind, dueAt: timer.dueAt };
    try {
      const { reply } = await this.#processor.dispatch(timer.sessionId, command);
      this.#log.info({ sessionId: timer.sessionId, kind: timer.kind, reply }, "timer handled");
      return true;
    } catch (err) {
      // A session row always exists for its timers (foreign key), so a missing one is a bug, as is any other failure.
      if (err instanceof SessionNotFoundError) this.#log.error({ sessionId: timer.sessionId, kind: timer.kind }, "timer for a missing session");
      else this.#log.error({ sessionId: timer.sessionId, kind: timer.kind, code: (err as { code?: string }).code, message: (err as Error).message }, "timer command failed; retrying later");
      return false;
    }
  }

  /**
   * Sleeps until the next due time, at most maxSleepMs (the hourly safety re-read). `delayMs` (after an error) is
   * used as is: an overdue timer that keeps failing must not turn into a busy loop against the database.
   */
  #schedule(delayMs?: number): void {
    if (this.#stopped) return;
    const now = this.#clock.now();
    const untilDue = this.#nextDue === null ? this.#maxSleepMs : Math.max(0, this.#nextDue - now);
    const wakeAt = now + (delayMs ?? Math.min(untilDue, this.#maxSleepMs));
    if (this.#handle !== null && this.#wakeAt === wakeAt) return;
    this.#cancelWake();
    this.#wakeAt = wakeAt;
    this.#handle = this.#clock.setTimeout(() => {
      this.#handle = null;
      this.#wakeAt = null;
      void this.sweep();
    }, wakeAt - now);
  }

  #cancelWake(): void {
    if (this.#handle !== null) this.#clock.clearTimeout(this.#handle);
    this.#handle = null;
    this.#wakeAt = null;
  }
}

/** The earlier of two due times (null = none). */
function earlier(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

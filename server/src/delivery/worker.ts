// The outbox delivery worker (P7-T03, D17): at-least-once delivery of record revisions, with the receiver's
// idempotency key making the effect exactly-once.
//
// - Event-driven, like the sweeper (D09, rev 3: no polling, so Neon can suspend): it sleeps until the earliest
//   deliverable row is due, and `notify()` wakes it after a commit queued a row. A safety re-read runs at most hourly.
// - A claim leases rows (`sending`, next_attempt_at = now + lease) inside a short transaction with FOR UPDATE SKIP
//   LOCKED, then delivers outside it. A crash mid-delivery leaves the lease to expire, and the row is retried.
// - Per session, in revision order: rev n+1 is not deliverable while rev n is pending or sending (outbox.ts), so a
//   consumer never sees an older revision after a newer one. A dead rev n releases n+1.
// - Retries: exponential backoff with jitter; 4xx other than 408/429 → dead at once; `maxAttempts` → dead.
// - Every delivered record is logged (without its signed file links, P4 review #8); a dead one is logged as an error and
//   stays visible in the timeline (outbox list).
import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";
import type { Secret } from "../config.js";
import { claimDueOutbox, earliestOutboxDueAt, type OutboxEntry, saveOutbox } from "../db/repos/outbox.js";
import { getRecord } from "../db/repos/records.js";
import { withTx } from "../db/tx.js";
import { withoutFileUrls } from "../domain/record.js";
import { realClock, type SweeperClock } from "../jobs/sweeper.js";
import { failpoint } from "../util/failpoints.js";
import { type DeliveryResult, postRecord } from "./http.js";

export interface OutboxWorkerOptions {
  pool: pg.Pool;
  log: FastifyBaseLogger;
  url: Secret;
  hookSecret: Secret;
  fetchImpl?: typeof fetch;
  clock?: SweeperClock;
  /** Random in [0, 1) for the backoff jitter. */
  random?: () => number;
  /** Per-attempt timeout (default 10 s). */
  timeoutMs?: number;
  /** Attempts before a row goes dead (default 10). */
  maxAttempts?: number;
  /** Backoff after attempt n: min(capMs, baseMs × 2^(n−1)), then jitter to 50–100% of that (defaults 2 s, 10 min). */
  backoff?: { baseMs: number; capMs: number };
  /** Deliveries at once (default 2: two sessions' rows in parallel, a session's own rows in order). */
  concurrency?: number;
  /** How long a claim holds a row (default timeout + 20 s). */
  leaseMs?: number;
  /** The longest sleep: the safety re-read (default 1 hour). */
  maxSleepMs?: number;
  /** Wait before trying again after a database error (default 5 s). */
  retryDelayMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class OutboxWorker {
  readonly #pool: pg.Pool;
  readonly #log: FastifyBaseLogger;
  readonly #url: Secret;
  readonly #hookSecret: Secret;
  readonly #fetch: typeof fetch | undefined;
  readonly #clock: SweeperClock;
  readonly #random: () => number;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #backoff: { baseMs: number; capMs: number };
  readonly #concurrency: number;
  readonly #leaseMs: number;
  readonly #maxSleepMs: number;
  readonly #retryDelayMs: number;
  #handle: unknown = null;
  #running: Promise<void> | null = null;
  #again = false;
  #stopped = true;

  constructor(options: OutboxWorkerOptions) {
    this.#pool = options.pool;
    this.#log = options.log;
    this.#url = options.url;
    this.#hookSecret = options.hookSecret;
    this.#fetch = options.fetchImpl;
    this.#clock = options.clock ?? realClock;
    this.#random = options.random ?? Math.random;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxAttempts = options.maxAttempts ?? 10;
    this.#backoff = options.backoff ?? { baseMs: 2_000, capMs: 10 * 60_000 };
    this.#concurrency = options.concurrency ?? 2;
    this.#leaseMs = options.leaseMs ?? this.#timeoutMs + 20_000;
    this.#maxSleepMs = options.maxSleepMs ?? 60 * 60_000;
    this.#retryDelayMs = options.retryDelayMs ?? 5_000;
  }

  /** Starts the worker: whatever is already due (rows left by a stop or crash) is delivered now. */
  async start(): Promise<void> {
    this.#stopped = false;
    await this.#run();
  }

  /** A command committed a new outbox row: deliver it now. No query unless the worker is idle. */
  notify(): void {
    if (this.#stopped) return;
    void this.#run();
  }

  /** Stops waking up and waits for deliveries in flight (their rows are saved before this returns). */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#handle !== null) this.#clock.clearTimeout(this.#handle);
    this.#handle = null;
    await this.#running;
  }

  /** One drain at a time; a call while one runs makes it go around once more. */
  #run(): Promise<void> {
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    this.#running = (async () => {
      try {
        do {
          this.#again = false;
          await this.#drain();
        } while (this.#again && !this.#stopped);
      } finally {
        this.#running = null;
      }
      await this.#sleepUntilNext();
    })();
    return this.#running;
  }

  async #drain(): Promise<void> {
    while (!this.#stopped) {
      let claimed: OutboxEntry[];
      try {
        claimed = await this.#claim();
      } catch (err) {
        this.#log.error({ code: (err as { code?: string }).code, message: (err as Error).message }, "outbox claim failed");
        return;
      }
      if (claimed.length === 0) return;
      await Promise.all(claimed.map((row) => this.#deliver(row)));
    }
  }

  /** Leases the due rows: `sending`, held until now + lease, with the attempt counted (a crash can't loop forever). */
  async #claim(): Promise<OutboxEntry[]> {
    const now = new Date(this.#clock.now());
    return withTx(this.#pool, async (tx) => {
      const rows = await claimDueOutbox(tx, { now, limit: this.#concurrency });
      const leased: OutboxEntry[] = [];
      for (const row of rows) {
        const saved = await saveOutbox(tx, {
          id: row.id,
          status: "sending",
          attempts: row.attempts + 1,
          nextAttemptAt: new Date(now.getTime() + this.#leaseMs),
          lastError: row.lastError,
          deliveredAt: null,
        });
        if (saved) leased.push(saved);
      }
      return leased;
    });
  }

  async #deliver(row: OutboxEntry): Promise<void> {
    const log = this.#log.child({ sessionId: row.sessionId, revision: row.revision, attempt: row.attempts });
    try {
      const record = await getRecord(this.#pool, row.sessionId, row.revision);
      // The FK guarantees the record exists; if it somehow doesn't, retrying can't help.
      const result: DeliveryResult = record
        ? await postRecord({
            url: this.#url,
            hookSecret: this.#hookSecret,
            idempotencyKey: `${row.sessionId}:${row.revision}`,
            body: JSON.stringify(record.payload),
            timeoutMs: this.#timeoutMs,
            fetchImpl: this.#fetch,
          })
        : { kind: "dead", error: "record not found" };
      const now = new Date(this.#clock.now());
      if (result.kind === "delivered") {
        failpoint("delivery.afterPost"); // chaos tests: the receiver has it, the row doesn't say so yet
        await saveOutbox(this.#pool, { id: row.id, status: "delivered", attempts: row.attempts, nextAttemptAt: now, lastError: null, deliveredAt: now });
        // The brief allows logging as delivery; every delivered record is logged, without its signed file links.
        log.info({ record: withoutFileUrls(record?.payload) }, "record delivered");
        return;
      }
      const dead = result.kind === "dead" || row.attempts >= this.#maxAttempts;
      const next = new Date(now.getTime() + (dead ? 0 : this.#delay(row.attempts)));
      await saveOutbox(this.#pool, { id: row.id, status: dead ? "dead" : "pending", attempts: row.attempts, nextAttemptAt: next, lastError: result.error, deliveredAt: null });
      if (dead) log.error({ error: result.error }, "record delivery failed for good (dead)");
      else log.warn({ error: result.error, retryInMs: next.getTime() - now.getTime() }, "record delivery failed; will retry");
    } catch (err) {
      // The row stays leased (`sending`) and is picked up again when the lease expires.
      log.error({ code: (err as { code?: string }).code, message: (err as Error).message }, "outbox delivery bookkeeping failed");
    }
  }

  #delay(attempt: number): number {
    const exponential = Math.min(this.#backoff.capMs, this.#backoff.baseMs * 2 ** (attempt - 1));
    return Math.round(exponential * (0.5 + this.#random() * 0.5));
  }

  /** Sleeps until the next deliverable row is due (or the safety re-read); notify() wakes it earlier. */
  async #sleepUntilNext(): Promise<void> {
    if (this.#stopped) return;
    let delay = this.#maxSleepMs;
    try {
      const due = await earliestOutboxDueAt(this.#pool);
      if (due) delay = Math.min(this.#maxSleepMs, Math.max(0, due.getTime() - this.#clock.now()));
    } catch (err) {
      this.#log.error({ code: (err as { code?: string }).code, message: (err as Error).message }, "outbox schedule read failed");
      delay = this.#retryDelayMs;
    }
    if (this.#stopped) return;
    if (this.#handle !== null) this.#clock.clearTimeout(this.#handle);
    this.#handle = this.#clock.setTimeout(() => {
      this.#handle = null;
      void this.#run();
    }, delay);
  }
}

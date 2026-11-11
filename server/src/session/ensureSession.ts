// Lazy session creation (D08, protocol.md §2). The browser picks the session id (a UUIDv4); the first valid /chat
// connect, /call connect or upload for an unknown id creates the session and its `session.created` event.
// Loading an existing session is never rate-limited and never counts as user activity.
import type pg from "pg";
import { appendEvent } from "../db/repos/events.js";
import { getSession, insertSession, lockSession, type Session } from "../db/repos/sessions.js";
import { upsertTimer } from "../db/repos/timers.js";
import { withTx } from "../db/tx.js";
import type { CreationLimiter } from "./creationLimit.js";

/** What caused the session to be created; recorded in the `session.created` event. */
export type SessionOrigin = "chat" | "call" | "upload" | "testApi";

/** PD10: the page was opened; if no call starts within this long, the chat takes over (the `noCallStart` timer). */
export const DEFAULT_NO_CALL_START_MS = 2 * 60 * 1000;

/** What a newly created session starts with (P4-T04): its `noCallStart` deadline, reported to the sweeper. */
export interface NewSessionSettings {
  noCallStartMs: number;
  onTimerScheduled?: (dueAt: Date) => void;
}

export interface EnsureSessionOptions {
  via: SessionOrigin;
  /** Limits creation per client; omit for trusted callers (the token-gated test API). */
  limit?: { limiter: CreationLimiter; key: string };
  /** Timers a new session starts with; none when omitted. */
  newSession?: NewSessionSettings;
}

export type EnsureSessionResult =
  | { ok: true; session: Session; created: boolean }
  | { ok: false; reason: "rate_limited" };

/** Creations in progress in this process, by session id, so concurrent connects for one new id share one attempt. */
const creating = new Map<string, Promise<EnsureSessionResult>>();

/**
 * Loads the session, or creates it if it doesn't exist. `id` must already be a canonical UUIDv4 (parseSessionId).
 * Concurrent calls for one new id create it exactly once and use at most one rate-limit slot: in this process they
 * join a single attempt; across processes the insert is `ON CONFLICT DO NOTHING` and the loser reads the winner's row.
 */
export async function ensureSession(pool: pg.Pool, id: string, options: EnsureSessionOptions): Promise<EnsureSessionResult> {
  const existing = await getSession(pool, id);
  if (existing) return { ok: true, session: existing, created: false };

  const inProgress = creating.get(id);
  if (inProgress) {
    const joined = await inProgress.catch(() => null);
    if (joined?.ok) return { ok: true, session: joined.session, created: false };
    // The shared attempt failed, or was refused on another client's budget: try once on our own.
    return create(pool, id, options);
  }
  const attempt = create(pool, id, options);
  creating.set(id, attempt);
  try {
    return await attempt;
  } finally {
    creating.delete(id);
  }
}

async function create(pool: pg.Pool, id: string, { via, limit, newSession }: EnsureSessionOptions): Promise<EnsureSessionResult> {
  if (limit && !limit.limiter.tryAcquire(limit.key)) {
    // A concurrent connect for the same id (e.g. chat and call opening together) may have just used the last slot
    // to create this very session; joining it creates nothing, so it isn't refused.
    const created = await getSession(pool, id);
    return created ? { ok: true, session: created, created: false } : { ok: false, reason: "rate_limited" };
  }
  let result: { session: Session; created: boolean };
  const noCallStartAt = newSession ? new Date(Date.now() + newSession.noCallStartMs) : null;
  try {
    result = await withTx(pool, async (tx) => {
      const inserted = await insertSession(tx, { id });
      if (!inserted) {
        // Another connection created it after our read. Its transaction has committed, so the row is visible.
        const session = await getSession(tx, id);
        if (!session) throw new Error("session vanished after a conflicting insert");
        return { session, created: false };
      }
      // Our own uncommitted row: the lock is free, and taking it keeps appendEvent's precondition explicit.
      const session = await lockSession(tx, id);
      if (!session) throw new Error("inserted session not found");
      await appendEvent(tx, { sessionId: id, type: "session.created", channel: "system", payload: { via } });
      if (noCallStartAt) await upsertTimer(tx, { sessionId: id, kind: "noCallStart", dueAt: noCallStartAt });
      return { session, created: true };
    });
  } catch (err) {
    limit?.limiter.release(limit.key);
    throw err;
  }
  if (!result.created) limit?.limiter.release(limit.key);
  else if (noCallStartAt) newSession?.onTimerScheduled?.(noCallStartAt);
  return { ok: true, ...result };
}

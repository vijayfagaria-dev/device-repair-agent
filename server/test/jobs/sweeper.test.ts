// The timer sweeper and TimerFired (P3-T05): fires on time and on boot, never during a call, issues no queries
// while idle, and fires each timer once with two sweepers. A fake clock drives both the sweeper and the processor.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/pool.js";
import { listEvents } from "../../src/db/repos/events.js";
import { listOutbox } from "../../src/db/repos/outbox.js";
import { listRecords } from "../../src/db/repos/records.js";
import { listTimers, type TimerKind, upsertTimer } from "../../src/db/repos/timers.js";
import { Sweeper, type SweeperClock } from "../../src/jobs/sweeper.js";
import { createLogger } from "../../src/log.js";
import type { SessionServices } from "../../src/session/services.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { seedSession } from "../helpers/seed.js";
import { seedCall, testServices } from "../helpers/session.js";

let schema: TestSchema;
let db: Database;

beforeAll(async () => {
  ({ schema, db } = await createMigratedSchema("sweeper", { max: 10 }));
});
afterAll(async () => {
  await schema.drop();
});

const MINUTE = 60_000;
const log = createLogger("silent");

/** A manual clock: setTimeout callbacks run only when advance() passes their time. */
class FakeClock implements SweeperClock {
  #now: number;
  #next = 1;
  readonly pending = new Map<number, { at: number; fn: () => void }>();

  constructor(start: number) {
    this.#now = start;
  }
  now = () => this.#now;
  setTimeout = (fn: () => void, ms: number) => {
    const id = this.#next++;
    this.pending.set(id, { at: this.#now + ms, fn });
    return id;
  };
  clearTimeout = (handle: unknown) => {
    this.pending.delete(handle as number);
  };
  /**
   * Moves time forward, running due callbacks in order and letting each sweep finish before going on. A sweeper that
   * keeps rescheduling itself without time passing (a busy loop) fails the test instead of hanging it.
   */
  async advance(ms: number, sweepers: Sweeper[]): Promise<void> {
    const target = this.#now + ms;
    for (let runs = 0; ; runs++) {
      const [id, due] = [...this.pending].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0] ?? [];
      if (id === undefined || !due) break;
      if (runs >= 100) throw new Error("runaway: the sweeper rescheduled itself 100 times within one advance()");
      this.pending.delete(id);
      this.#now = due.at;
      due.fn();
      for (const sweeper of sweepers) await sweeper.settled();
    }
    this.#now = target;
  }
}

interface Rig {
  clock: FakeClock;
  services: SessionServices;
  sweeper: Sweeper;
  db: Database;
}

/** A processor and sweeper sharing a fake clock and their own pool (so query counts are theirs alone). */
function rig(start = Date.UTC(2030, 0, 1, 4, 0, 0)): Rig {
  const clock = new FakeClock(start);
  const own = schema.open({ max: 4 });
  const services = testServices(own, { now: () => new Date(clock.now()) });
  const sweeper = new Sweeper({ pool: own.pool, processor: services.processor, log, clock, retryDelayMs: 30_000 });
  services.processor.onTimerScheduled = (dueAt) => sweeper.notify(dueAt);
  return { clock, services, sweeper, db: own };
}

const fired = async (sessionId: string) => (await listEvents(db.pool, sessionId)).filter((e) => e.type === "timer.fired").map((e) => e.payload.kind);
/** Removes the sessions' timers (tests that leave overdue ones behind on purpose clean up after themselves). */
const clearTimers = async (sessionIds: string[]) => {
  await db.pool.query("DELETE FROM timers WHERE session_id = ANY($1::uuid[])", [sessionIds]);
};
const timerKinds = async (sessionId: string) => (await listTimers(db.pool, sessionId)).map((t) => t.kind).sort();

describe("firing", () => {
  it("fires a due timer when its time comes, not before; a timer moved later by activity waits for its new time", async () => {
    const { clock, services, sweeper } = rig();
    await sweeper.start();
    const id = await seedSession(db.pool);
    await services.processor.dispatch(id, { type: "Test.Activity" }); // idle due in 15 min (notify: no query)

    await clock.advance(10 * MINUTE, [sweeper]);
    await services.processor.dispatch(id, { type: "Test.Activity" }); // moves idle to 25 min
    await clock.advance(5 * MINUTE + 1, [sweeper]); // the old due time passes: the wake-up finds nothing due
    expect(await fired(id)).toEqual([]);

    await clock.advance(10 * MINUTE - 2, [sweeper]);
    expect(await fired(id)).toEqual([]);
    await clock.advance(1, [sweeper]); // exactly the new due time
    expect(await fired(id)).toEqual(["idle"]);
    expect(await timerKinds(id)).toEqual(["sessionExpiry"]); // fired timers are removed; the 7-day one stays
    await sweeper.stop();
  });

  it("with the real clock, records timer.fired within 5 s of due_at", async () => {
    const own = schema.open({ max: 4 });
    const services = testServices(own);
    const sweeper = new Sweeper({ pool: own.pool, processor: services.processor, log });
    services.processor.onTimerScheduled = (dueAt) => sweeper.notify(dueAt);
    await sweeper.start();
    const id = await seedSession(db.pool);
    const dueAt = new Date(Date.now() + 300);
    await services.processor.dispatch(id, { type: "Test.Noop" }); // nothing scheduled
    await upsertTimer(db.pool, { sessionId: id, kind: "noCallStart", dueAt });
    sweeper.notify(dueAt); // as the processor does for timers it commits
    const deadline = Date.now() + 5_000;
    while ((await fired(id)).length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const event = (await listEvents(db.pool, id)).find((e) => e.type === "timer.fired");
    expect(event?.payload).toEqual({ kind: "noCallStart", dueAt: dueAt.toISOString() });
    expect((event?.createdAt.getTime() ?? Infinity) - dueAt.getTime()).toBeLessThanOrEqual(5_000);
    await sweeper.stop();
  });

  it("fires on boot a timer whose deadline passed while the server was down", async () => {
    const { clock, sweeper } = rig();
    const id = await seedSession(db.pool);
    await upsertTimer(db.pool, { sessionId: id, kind: "sessionExpiry", dueAt: new Date(clock.now() - 3 * 60 * MINUTE) });
    await sweeper.start();
    await clock.advance(0, [sweeper]); // the boot wake-up is immediate
    expect(await fired(id)).toEqual(["sessionExpiry"]);
    expect(await timerKinds(id)).toEqual([]);
    await sweeper.stop();
  });

  it("never fires idle during an active call; the call's end re-arms it, and then it fires", async () => {
    const { clock, services, sweeper } = rig();
    await sweeper.start();
    const id = await seedSession(db.pool);
    const callId = `c${id.slice(0, 8)}`;
    await seedCall(db, id, callId);
    await services.processor.dispatch(id, { type: "Test.StartCall", callId } as never);
    // A stale idle timer (e.g. written by an older instance) that comes due mid-call.
    await upsertTimer(db.pool, { sessionId: id, kind: "idle", dueAt: new Date(clock.now() + MINUTE) });
    sweeper.notify(new Date(clock.now() + MINUTE));
    await clock.advance(2 * MINUTE, [sweeper]);
    expect(await fired(id)).toEqual([]);
    expect(await timerKinds(id)).toEqual([]); // removed, not fired

    await services.processor.dispatch(id, { type: "Test.EndCall" }); // re-arms idle: now + 15 min
    await clock.advance(15 * MINUTE, [sweeper]);
    expect(await fired(id)).toEqual(["idle"]);
    await sweeper.stop();
  });
});

describe("no polling (Neon compute budget)", () => {
  // Year 2000: every timer other tests leave in the shared schema is decades later than these clocks.
  const QUIET = Date.UTC(2000, 0, 1);

  it("issues zero database queries over a 10-minute idle window, with no timers or only later ones", async () => {
    const { clock, services, sweeper, db: own } = rig(QUIET);
    await sweeper.start(); // one read of min(due_at)
    const afterStart = own.stats.acquired;
    await clock.advance(10 * MINUTE, [sweeper]);
    expect(own.stats.acquired).toBe(afterStart);

    // A timer due in 15 min, scheduled through a command: the sweeper learns of it without querying.
    const id = await seedSession(db.pool);
    await services.processor.dispatch(id, { type: "Test.Activity" });
    const afterCommand = own.stats.acquired;
    await clock.advance(10 * MINUTE, [sweeper]);
    expect(own.stats.acquired).toBe(afterCommand);
    await sweeper.stop();
  });

  it("re-reads at most once an hour (the safety re-read)", async () => {
    // Earlier still: the test above leaves a timer 15 min after QUIET on purpose.
    const { clock, sweeper, db: own } = rig(Date.UTC(1995, 0, 1));
    await sweeper.start();
    const afterStart = own.stats.acquired;
    await clock.advance(59 * MINUTE, [sweeper]);
    expect(own.stats.acquired).toBe(afterStart);
    await clock.advance(MINUTE, [sweeper]);
    expect(own.stats.acquired - afterStart).toBe(2); // claim (none due) + min(due_at)
    await sweeper.stop();
  });

  it("a timer whose command keeps failing doesn't hold up other sessions' timers, and is retried after the delay", async () => {
    // Year 1980: no other test's timer is due this early, so the batch is exactly these two.
    const clock = new FakeClock(Date.UTC(1980, 0, 1));
    const own = schema.open({ max: 4 });
    const services = testServices(own, { now: () => new Date(clock.now()) });
    const [bad, good] = [await seedSession(db.pool), await seedSession(db.pool)];
    await upsertTimer(db.pool, { sessionId: bad, kind: "noCallStart", dueAt: new Date(clock.now() - 2 * MINUTE) }); // first in order
    await upsertTimer(db.pool, { sessionId: good, kind: "noCallStart", dueAt: new Date(clock.now() - MINUTE) });
    let failures = 0;
    const processor = {
      dispatch: (sessionId: string, command: never) => {
        if (sessionId !== bad) return services.processor.dispatch(sessionId, command);
        failures += 1;
        return Promise.reject(new Error("handler bug for this one session"));
      },
    } as unknown as SessionServices["processor"];
    const sweeper = new Sweeper({ pool: own.pool, processor, log, clock, retryDelayMs: 30_000 });
    await sweeper.start();
    await clock.advance(0, [sweeper]);
    expect(await fired(good)).toEqual(["noCallStart"]);
    expect(failures).toBe(1);
    expect([...clock.pending.values()].map((t) => t.at - clock.now())).toEqual([30_000]); // no busy loop on the bad one
    await clock.advance(30_000, [sweeper]);
    expect(failures).toBe(2);
    await sweeper.stop();
    await clearTimers([bad]); // an overdue leftover would wake later tests' sweepers early
  });

  it("stop() during a sweep ends it after the timer in progress, not after the whole backlog (bounded shutdown)", async () => {
    // Year 1975: no other test's timer is due this early.
    const clock = new FakeClock(Date.UTC(1975, 0, 1));
    const own = schema.open({ max: 4 });
    const services = testServices(own, { now: () => new Date(clock.now()) });
    const ids: string[] = [await seedSession(db.pool), await seedSession(db.pool), await seedSession(db.pool)];
    const [first, second, third] = ids as [string, string, string];
    for (const [index, id] of ids.entries()) {
      await upsertTimer(db.pool, { sessionId: id, kind: "noCallStart", dueAt: new Date(clock.now() - (3 - index) * MINUTE) });
    }
    let stopping: Promise<void> | undefined;
    const processor = {
      dispatch: async (sessionId: string, command: never) => {
        const result = await services.processor.dispatch(sessionId, command);
        stopping ??= sweeper.stop(); // shutdown begins while the first timer is being handled
        return result;
      },
    } as unknown as SessionServices["processor"];
    const sweeper = new Sweeper({ pool: own.pool, processor, log, clock, batchSize: 2 });
    await sweeper.start();
    await clock.advance(0, [sweeper]);
    await stopping;
    expect([await fired(first), await fired(second), await fired(third)]).toEqual([["noCallStart"], [], []]);
    expect(clock.pending.size).toBe(0);
    await clearTimers(ids); // the two left for "the next boot" would wake later tests' sweepers early
  });

  it("after a database error, retries after the retry delay instead of spinning on an overdue timer", async () => {
    const { clock, sweeper, db: own } = rig();
    const id = await seedSession(db.pool);
    await upsertTimer(db.pool, { sessionId: id, kind: "noCallStart", dueAt: new Date(clock.now() - MINUTE) });
    await sweeper.start();
    await own.pool.end(); // the database goes away
    await clock.advance(0, [sweeper]); // the overdue wake-up fails
    expect([...clock.pending.values()].map((t) => t.at - clock.now())).toEqual([30_000]);
    await sweeper.stop();
  });
});

describe("a timer committed while the sweeper reads min(due_at)", () => {
  // The read's snapshot predates the commit, so its result can't include the new timer; the notify() that the commit
  // sent must not be overwritten by that stale result (else the timer waits for the hourly re-read).
  // Years 1990 and 1985: earlier than every timer the other tests (including the case before) leave in the shared
  // schema, so the stale read never returns a timer that would wake the sweeper anyway.
  const EPOCH = { start: Date.UTC(1990, 0, 1), sweep: Date.UTC(1985, 0, 1) };

  /** A pool whose min(due_at) reads run `during` after the query returns and before the caller sees the result. */
  function hookEarliestRead(pool: pg.Pool, during: () => Promise<void>): { pool: pg.Pool; arm: () => void } {
    let armed = false;
    const hooked = new Proxy(pool, {
      get(target, property) {
        if (property === "query") {
          return async (text: string, values?: unknown[]) => {
            const result = await target.query(text, values);
            if (armed && text.includes("min(due_at)")) {
              armed = false;
              await during();
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { pool: hooked, arm: () => (armed = true) };
  }

  for (const when of ["start", "sweep"] as const) {
    it(`still wakes on time (read in ${when}())`, async () => {
      const clock = new FakeClock(EPOCH[when]);
      const own = schema.open({ max: 4 });
      const services = testServices(own, { now: () => new Date(clock.now()) });
      const id = await seedSession(db.pool);
      const hook = hookEarliestRead(own.pool, async () => {
        await services.processor.dispatch(id, { type: "Test.Activity" }); // idle due in 15 min, reported via notify()
      });
      const sweeper = new Sweeper({ pool: hook.pool, processor: services.processor, log, clock });
      services.processor.onTimerScheduled = (dueAt) => sweeper.notify(dueAt);
      if (when === "start") hook.arm();
      await sweeper.start();
      if (when === "sweep") {
        hook.arm();
        await sweeper.sweep();
      }
      await clock.advance(15 * MINUTE, [sweeper]);
      expect(await fired(id)).toEqual(["idle"]);
      await sweeper.stop();
    });
  }
});

describe("two sweepers on one database (deploy overlap)", () => {
  it("fire each timer exactly once", async () => {
    const a = rig();
    const b = rig();
    const ids = await Promise.all(Array.from({ length: 15 }, () => seedSession(db.pool)));
    // Kinds that don't affect each other: idle and sessionExpiry finalize (and close) the session, which clears the rest.
    const kinds: TimerKind[] = ["orphanUploads", "noCallStart"];
    for (const id of ids) {
      for (const kind of kinds) await upsertTimer(db.pool, { sessionId: id, kind, dueAt: new Date(a.clock.now() - MINUTE) });
    }
    await Promise.all([a.sweeper.start(), b.sweeper.start()]);
    await Promise.all([a.sweeper.sweep(), b.sweeper.sweep()]);
    await Promise.all([a.sweeper.settled(), b.sweeper.settled()]);
    for (const id of ids) {
      expect((await fired(id)).sort(), id).toEqual([...kinds].sort());
      expect(await timerKinds(id)).toEqual([]);
    }
    await Promise.all([a.sweeper.stop(), b.sweeper.stop()]);
  });

  it("finalize an idle session exactly once (one record, one outbox row) even when both fire its timer", async () => {
    const a = rig();
    const b = rig();
    const ids = await Promise.all(Array.from({ length: 10 }, () => seedSession(db.pool)));
    for (const id of ids) await upsertTimer(db.pool, { sessionId: id, kind: "idle", dueAt: new Date(a.clock.now() - MINUTE) });
    await Promise.all([a.sweeper.start(), b.sweeper.start()]);
    await Promise.all([a.sweeper.sweep(), b.sweeper.sweep()]);
    await Promise.all([a.sweeper.settled(), b.sweeper.settled()]);
    for (const id of ids) {
      const events = await listEvents(db.pool, id);
      expect(events.filter((e) => e.type === "session.finalized"), id).toHaveLength(1);
      expect(await listRecords(db.pool, id), id).toHaveLength(1);
      expect(await listOutbox(db.pool, id), id).toHaveLength(1);
      expect(await timerKinds(id)).toEqual([]);
    }
    await Promise.all([a.sweeper.stop(), b.sweeper.stop()]);
  });
});

describe("TimerFired (re-checked under the session lock)", () => {
  it("is a no-op for a timer that is gone or not yet due", async () => {
    const { clock, services } = rig();
    const id = await seedSession(db.pool);
    const dueAt = new Date(clock.now());
    expect((await services.processor.dispatch(id, { type: "TimerFired", kind: "idle", dueAt } as never)).reply).toEqual({ fired: false, reason: "notDue" });
    await upsertTimer(db.pool, { sessionId: id, kind: "idle", dueAt: new Date(clock.now() + MINUTE) });
    const result = await services.processor.dispatch(id, { type: "TimerFired", kind: "idle", dueAt } as never);
    expect(result).toEqual({ reply: { fired: false, reason: "notDue" }, update: null });
    expect(await timerKinds(id)).toEqual(["idle"]);
  });
});

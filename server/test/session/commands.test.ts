// The command processor (P3-T01; D11): serialization, rollback, publish after commit, re-entrancy, effects and the
// activity timer rules (P3-T05 steps 1–2), against the throwaway test Postgres.
import { randomUUID } from "node:crypto";
import { Role } from "@device-repair/shared/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/pool.js";
import { listChatMessages } from "../../src/db/repos/chatMessages.js";
import { listEvents } from "../../src/db/repos/events.js";
import { listFieldCandidates } from "../../src/db/repos/fieldCandidates.js";
import { getInputRequest } from "../../src/db/repos/inputRequests.js";
import { getSession } from "../../src/db/repos/sessions.js";
import { listTimers } from "../../src/db/repos/timers.js";
import { SessionNotFoundError, UnsupportedCommandError } from "../../src/session/commands.js";
import type { SessionUpdate } from "../../src/session/hub.js";
import type { SessionServices } from "../../src/session/services.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { seedSession } from "../helpers/seed.js";
import { TEST_TIMERS, testServices } from "../helpers/session.js";

let schema: TestSchema;
let db: Database;
let services: SessionServices;

beforeAll(async () => {
  ({ schema, db } = await createMigratedSchema("commands", { max: 10 }));
  services = testServices(db);
});
afterAll(async () => {
  await schema.drop();
});

const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const withTimeout = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms))]);

describe("serialization (D11)", () => {
  it("100 concurrent commands on one session get consecutive seq values with no lost writes", async () => {
    const id = await seedSession(db.pool);
    await Promise.all(range(100).map((n) => services.processor.dispatch(id, { type: "Test.Append", n } as never)));
    const events = await listEvents(db.pool, id);
    expect(events.map((e) => e.seq)).toEqual(range(100).map((n) => n + 1));
    expect(new Set(events.map((e) => e.payload.n))).toEqual(new Set(range(100)));
    expect((await getSession(db.pool, id))?.version).toBe(100);
    expect(services.processor.busySessions).toBe(0);
  });

  it("…also when they are split across two processor instances with separate mutexes (deploy overlap)", async () => {
    const other = schema.open({ max: 10 }); // another process: its own pool, mutex and hub
    const second = testServices(other);
    const id = await seedSession(db.pool);
    const started = Date.now();
    await Promise.all(range(100).map((n) => (n % 2 === 0 ? services : second).processor.dispatch(id, { type: "Test.Append", n } as never)));
    const events = await listEvents(db.pool, id);
    expect(events.map((e) => e.seq)).toEqual(range(100).map((n) => n + 1));
    expect(new Set(events.map((e) => e.payload.n))).toEqual(new Set(range(100)));
    expect((await getSession(db.pool, id))?.version).toBe(100);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("keeps per-session publish order equal to commit order", async () => {
    const id = await seedSession(db.pool);
    const seen: number[] = [];
    const unsubscribe = services.hub.subscribe(id, (update) => seen.push(...update.events.map((e) => e.seq)));
    await Promise.all(range(30).map((n) => services.processor.dispatch(id, { type: "Test.Append", n } as never)));
    unsubscribe();
    expect(seen).toEqual(range(30).map((n) => n + 1));
  });
});

describe("rollback", () => {
  it("a throwing handler writes nothing and publishes nothing", async () => {
    const id = await seedSession(db.pool);
    const published: SessionUpdate[] = [];
    const unsubscribe = services.hub.subscribe(id, (update) => published.push(update));
    await expect(services.processor.dispatch(id, { type: "Test.Throw" })).rejects.toThrow("handler failed on purpose");
    await expect(services.processor.dispatch(id, { type: "Test.ThrowAfterWrite" })).rejects.toThrow();
    unsubscribe();
    expect(published).toEqual([]);
    expect(await listEvents(db.pool, id)).toEqual([]);
    expect((await getSession(db.pool, id))?.version).toBe(0);
    // The session still works afterwards: the mutex was released.
    await services.processor.dispatch(id, { type: "Test.Append", n: 1 } as never);
    expect((await listEvents(db.pool, id)).map((e) => e.seq)).toEqual([1]);
  });

  it("a no-op decision writes and publishes nothing, and returns the reply", async () => {
    const id = await seedSession(db.pool);
    const published: SessionUpdate[] = [];
    const unsubscribe = services.hub.subscribe(id, (update) => published.push(update));
    const result = await services.processor.dispatch(id, { type: "Test.Noop" });
    unsubscribe();
    expect(result).toEqual({ reply: "nothing to do", update: null });
    expect(published).toEqual([]);
    expect((await getSession(db.pool, id))?.version).toBe(0);
  });

  it("refuses an unknown command before touching the database, and an unknown session", async () => {
    const before = db.stats.acquired;
    // (This used SubmitChatInput as the unknown command until P4-T02 registered a handler for it.)
    await expect(services.processor.dispatch(randomUUID(), { type: "NoSuchCommand" })).rejects.toBeInstanceOf(UnsupportedCommandError);
    expect(db.stats.acquired).toBe(before);
    await expect(services.processor.dispatch(randomUUID(), { type: "Test.Noop" })).rejects.toBeInstanceOf(SessionNotFoundError);
  });
});

describe("publish after commit, post-commit reactions, re-entrancy", () => {
  it("listeners see committed state: the published rows are visible to another connection", async () => {
    const id = await seedSession(db.pool);
    const reads: Promise<number>[] = [];
    const unsubscribe = services.hub.subscribe(id, (update) => {
      const other = schema.open({ max: 1 });
      reads.push(other.pool.query("SELECT count(*)::int AS n FROM events WHERE session_id = $1 AND seq = $2", [id, update.events[0]?.seq]).then((r) => r.rows[0].n));
    });
    await services.processor.dispatch(id, { type: "Test.Append", n: 1 } as never);
    unsubscribe();
    expect(await Promise.all(reads)).toEqual([1]);
  });

  it("a listener that dispatches a command does not deadlock (< 2 s)", async () => {
    const id = await seedSession(db.pool);
    let nested: Promise<unknown> | null = null;
    const unsubscribe = services.hub.subscribe(id, () => {
      nested ??= services.processor.dispatch(id, { type: "Test.Append", n: 2 } as never);
    });
    const started = Date.now();
    await withTimeout(services.processor.dispatch(id, { type: "Test.Append", n: 1 } as never), 2_000);
    await withTimeout(nested as unknown as Promise<unknown>, 2_000);
    unsubscribe();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect((await listEvents(db.pool, id)).map((e) => e.payload.n)).toEqual([1, 2]);
  });

  it("reactions run after every command and after release, so they may dispatch more commands", async () => {
    const local = testServices(db);
    const id = await seedSession(db.pool);
    const reacted: (number | null)[] = [];
    local.processor.addReaction(async (sessionId, update) => {
      reacted.push(update?.events[0]?.seq ?? null);
      // Like reconcile: act once, then find nothing to do.
      if (reacted.length === 1) await local.processor.dispatch(sessionId, { type: "Test.Append", n: 2 } as never);
    });
    await withTimeout(local.processor.dispatch(id, { type: "Test.Append", n: 1 } as never), 2_000);
    expect(reacted).toEqual([1, 2]);
    await local.processor.react(id); // on demand (chat connect, boot)
    expect(reacted).toEqual([1, 2, null]);
  });

  it("a failing reaction is logged, and the command stays committed", async () => {
    const local = testServices(db);
    local.processor.addReaction(() => {
      throw new Error("reaction failed");
    });
    const id = await seedSession(db.pool);
    await expect(local.processor.dispatch(id, { type: "Test.Append", n: 1 } as never)).resolves.toMatchObject({ update: { sessionId: id } });
    expect(await listEvents(db.pool, id)).toHaveLength(1);
  });
});

describe("effects", () => {
  it("writes each event's row with the event's seq, and copies the row's data into the payload", async () => {
    const id = await seedSession(db.pool);
    await services.processor.dispatch(id, { type: "Test.Say", messageId: "msgA1", text: "Hello" } as never);
    await services.processor.dispatch(id, { type: "Test.Candidate", field: "email", raw: "a@b.co", normalized: "a@b.co", evidence: "they said a at b" } as never);
    const [message] = await listChatMessages(db.pool, id);
    expect(message).toMatchObject({ id: "msgA1", eventSeq: 1, role: Role.AGENT, text: "Hello" });
    const events = await listEvents(db.pool, id);
    expect(events[0]?.payload).toEqual({ message: { id: "msgA1", role: "agent", text: "Hello", requestId: null } });
    expect((await listFieldCandidates(db.pool, id))[0]).toMatchObject({ eventSeq: 2, field: "email", evidence: "they said a at b" });
    // The LLM's evidence stays in its row; it isn't copied into the timeline.
    expect(events[1]?.payload.candidate).not.toHaveProperty("evidence");
  });

  it("keeps sessions.open_request_id in step with the open card, and refuses a second open card", async () => {
    const id = await seedSession(db.pool);
    await services.processor.dispatch(id, { type: "Test.OpenCard", requestId: "req_email_1", field: "email" } as never);
    expect((await getSession(db.pool, id))?.openRequestId).toBe("req_email_1");
    expect((await getInputRequest(db.pool, id, "req_email_1"))?.status).toBe("open");

    // A second open card fails the whole command (input_requests_one_open_idx), so nothing of it is written.
    const before = (await listEvents(db.pool, id)).length;
    await expect(services.processor.dispatch(id, { type: "Test.OpenCard", requestId: "req_serialNumber_1", field: "serialNumber" } as never)).rejects.toThrow(
      /input_requests_one_open_idx/,
    );
    expect(await getInputRequest(db.pool, id, "req_serialNumber_1")).toBeNull();
    expect(await listEvents(db.pool, id)).toHaveLength(before);

    await services.processor.dispatch(id, { type: "Test.CancelCard", requestId: "req_email_1" } as never);
    expect((await getSession(db.pool, id))?.openRequestId).toBeNull();
    expect((await getInputRequest(db.pool, id, "req_email_1"))?.status).toBe("cancelled");
  });
});

describe("activity and timers (P3-T05 steps 1–2)", () => {
  it("activity moves lastActivityAt, the idle timer and the session-expiry timer; a call removes idle; its end re-arms it", async () => {
    let now = new Date("2026-11-10T04:00:00Z");
    const scheduled: Date[] = [];
    const local = testServices(db, { now: () => now });
    local.processor.onTimerScheduled = (dueAt) => scheduled.push(dueAt);
    const id = await seedSession(db.pool);
    const timers = async () => Object.fromEntries((await listTimers(db.pool, id)).map((t) => [t.kind, t.dueAt.toISOString()]));
    const plus = (ms: number) => new Date(now.getTime() + ms).toISOString();

    await local.processor.dispatch(id, { type: "Test.Activity" });
    expect(await timers()).toEqual({ idle: plus(TEST_TIMERS.idleTimeoutMs), sessionExpiry: plus(TEST_TIMERS.sessionLifetimeMs) });
    expect((await getSession(db.pool, id))?.lastActivityAt.toISOString()).toBe(now.toISOString());
    expect(scheduled.map((d) => d.toISOString()).sort()).toEqual([plus(TEST_TIMERS.idleTimeoutMs), plus(TEST_TIMERS.sessionLifetimeMs)].sort());

    now = new Date("2026-11-10T04:05:00Z");
    await local.processor.dispatch(id, { type: "Test.StartCall", callId: "callA" } as never);
    expect(Object.keys(await timers())).toEqual(["sessionExpiry"]); // a live call removes the idle timer

    await local.processor.dispatch(id, { type: "Test.Activity" }); // activity during a call doesn't arm idle
    expect(Object.keys(await timers())).toEqual(["sessionExpiry"]);

    now = new Date("2026-11-10T04:09:00Z");
    await local.processor.dispatch(id, { type: "Test.EndCall" });
    expect((await timers()).idle).toBe(plus(TEST_TIMERS.idleTimeoutMs)); // the call's end re-arms it

    // Non-activity commands leave timers and lastActivityAt alone.
    now = new Date("2026-11-10T04:10:00Z");
    const before = await timers();
    await local.processor.dispatch(id, { type: "Test.Append", n: 1 } as never);
    expect(await timers()).toEqual(before);
    expect((await getSession(db.pool, id))?.lastActivityAt.toISOString()).toBe("2026-11-10T04:05:00.000Z");
  });
});

// Startup recovery (P8-T01) against a seeded, inconsistent database: an open call, a stale call pointer, a call row
// nobody points at, an outbox lease a dead process held, an overdue timer, a card that never opened, and orphaned
// uploads. After one recovery everything is consistent, each fix is counted in the log, and a second run does nothing.
import type { FastifyBaseLogger } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORPHAN_UPLOAD_AGE_MS, recoverOnBoot } from "../../src/boot/recover.js";
import type { Database } from "../../src/db/pool.js";
import { insertCall } from "../../src/db/repos/calls.js";
import { listCalls } from "../../src/db/repos/calls.js";
import { listEvents } from "../../src/db/repos/events.js";
import { listFiles } from "../../src/db/repos/files.js";
import { insertOutbox, listOutbox, saveOutbox } from "../../src/db/repos/outbox.js";
import { insertRecord } from "../../src/db/repos/records.js";
import { getSession } from "../../src/db/repos/sessions.js";
import { listTimers, upsertTimer } from "../../src/db/repos/timers.js";
import { Sweeper } from "../../src/jobs/sweeper.js";
import { createLogger } from "../../src/log.js";
import type { SessionServices } from "../../src/session/services.js";
import { answer, chatSession, openCard, sessionAtField, storeTestFile } from "../helpers/chatFlow.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { HASH, seedSession } from "../helpers/seed.js";
import { testServices } from "../helpers/session.js";

let schema: TestSchema;
let db: Database;
let services: SessionServices; // production handlers and the planner
let quiet: SessionServices; // the same handlers without the planner: a command whose reaction "never ran"

beforeAll(async () => {
  ({ schema, db } = await createMigratedSchema("recover", { max: 10 }));
  services = testServices(db, { planner: true });
  quiet = testServices(db, { planner: false });
});
afterAll(async () => {
  await schema.drop();
});

interface Line {
  level: string;
  obj: Record<string, unknown>;
  msg: string;
}
function capture(): { log: FastifyBaseLogger; lines: Line[] } {
  const lines: Line[] = [];
  const write = (level: string) => (obj: unknown, msg?: string) => lines.push({ level, obj: (typeof obj === "object" && obj !== null ? obj : {}) as Record<string, unknown>, msg: msg ?? String(obj) });
  const log = { info: write("info"), warn: write("warn"), error: write("error"), debug: write("debug"), child: () => log } as unknown as FastifyBaseLogger;
  return { log, lines };
}
const counts = (lines: Line[]) => Object.fromEntries(lines.filter((l) => l.msg.startsWith("recovery:")).map((l) => [l.msg, l.obj.count]));

function recover(log: FastifyBaseLogger) {
  const sweeper = new Sweeper({ pool: db.pool, processor: services.processor, log });
  services.processor.onTimerScheduled = (dueAt) => sweeper.notify(dueAt);
  return { sweeper, run: () => recoverOnBoot({ pool: db.pool, processor: services.processor, sweeper, log }) };
}

describe("recoverOnBoot", () => {
  it("repairs a seeded inconsistent database, counting each fix, and a second run finds nothing", async () => {
    // 1. A call that was running when the process died: the session points at it.
    const calling = await sessionAtField(db, services, "serialNumber");
    const callId = `c${calling.slice(0, 8)}`;
    await services.processor.dispatch(calling, { type: "StartCall", callId } as never);
    expect((await getSession(db.pool, calling))?.activeCallId).toBe(callId);

    // 2. A stale pointer: the call row already ended, the session still points at it.
    const stale = await seedSession(db.pool);
    await insertCall(db.pool, { id: `s${stale.slice(0, 8)}`, sessionId: stale });
    await db.pool.query("UPDATE calls SET ended_at = now(), end_reason = 'hangup' WHERE id = $1", [`s${stale.slice(0, 8)}`]);
    await db.pool.query("UPDATE sessions SET active_call_id = $2 WHERE id = $1", [stale, `s${stale.slice(0, 8)}`]);

    // 3. A call row with no end that its session doesn't point at.
    const unpointed = await seedSession(db.pool);
    await insertCall(db.pool, { id: `u${unpointed.slice(0, 8)}`, sessionId: unpointed });

    // 4. An outbox lease held by a process that died.
    const leased = await seedSession(db.pool);
    await insertRecord(db.pool, { sessionId: leased, revision: 1, outcome: "partial" as never, payload: { revision: 1 }, contentHash: HASH });
    const row = await insertOutbox(db.pool, { sessionId: leased, revision: 1, target: "webhook" });
    await saveOutbox(db.pool, { id: row.id, status: "sending", attempts: 1, nextAttemptAt: new Date(Date.now() + 25_000), lastError: null, deliveredAt: null });

    // 5. An overdue idle timer on an active session.
    const overdue = await sessionAtField(db, services, "email");
    await upsertTimer(db.pool, { sessionId: overdue, kind: "idle", dueAt: new Date(Date.now() - 60_000) });

    // 6. A card that never opened: an answer committed, its reaction (the planner) never ran.
    const missing = await chatSession(db, services);
    const first = await openCard(db, missing);
    await answer(quiet, missing, first?.id ?? "", first?.field ?? "", "smartphone");
    expect(await openCard(db, missing)).toBeNull();

    // 7. Uploads: an old orphan, an old file an answer names, a fresh unanswered one.
    const uploads = await sessionAtField(db, services, "purchaseInvoice");
    const orphan = await storeTestFile(db, uploads);
    const kept = await storeTestFile(db, uploads);
    const fresh = await storeTestFile(db, uploads);
    await answer(services, uploads, (await openCard(db, uploads))?.id ?? "", "purchaseInvoice", `file:${kept.id}`);
    const old = new Date(Date.now() - ORPHAN_UPLOAD_AGE_MS - 60_000);
    await db.pool.query("UPDATE files SET created_at = $2 WHERE id = ANY($1::text[])", [[orphan.id, kept.id], old]);

    const { log, lines } = capture();
    const { sweeper, run } = recover(log);
    const report = await run();
    await sweeper.stop();

    // Counted (other sessions in the schema may add their own, hence the lower bounds where a seed isn't unique).
    expect(report.danglingCalls).toBeGreaterThanOrEqual(3);
    expect(report).toMatchObject({ leasesReclaimed: 1, overdueTimers: 1, orphanUploads: 1 });
    expect(report.sessionsReconciled).toBeGreaterThanOrEqual(3);
    expect(counts(lines)).toEqual({
      "recovery: dangling calls ended": report.danglingCalls,
      "recovery: outbox leases reclaimed": 1,
      "recovery: overdue timers fired": 1,
      "recovery: active sessions reconciled": report.sessionsReconciled,
      "recovery: orphaned uploads deleted": 1,
    });

    // 1–3: every call ended with server_restart, no session points at a call, the chat says so.
    expect((await listCalls(db.pool, calling))[0]).toMatchObject({ endReason: "server_restart" });
    expect((await getSession(db.pool, calling))?.activeCallId).toBeNull();
    expect((await listEvents(db.pool, calling)).filter((e) => e.type === "call.ended").map((e) => e.payload.reason)).toEqual(["server_restart"]);
    expect((await listEvents(db.pool, calling)).some((e) => e.type === "chat.message" && JSON.stringify(e.payload).includes("The call was interrupted; let's continue here."))).toBe(true);
    expect((await getSession(db.pool, stale))?.activeCallId).toBeNull();
    expect((await listCalls(db.pool, unpointed))[0]?.endedAt).toBeInstanceOf(Date);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM calls WHERE ended_at IS NULL")).rows[0].n).toBe(0);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM sessions WHERE active_call_id IS NOT NULL")).rows[0].n).toBe(0);
    // The call's session carries on in chat: the card it was on is (still) open.
    expect((await openCard(db, calling))?.field).toBe("serialNumber");

    // 4: the lease is back to pending (and due).
    expect(await listOutbox(db.pool, leased)).toMatchObject([{ status: "pending" }]);
    // 5: the overdue timer fired: the idle finalization produced the partial record.
    expect(await getSession(db.pool, overdue)).toMatchObject({ status: "finalized", outcome: "partial", currentRevision: 1 });
    expect((await listTimers(db.pool, overdue)).map((t) => t.kind)).not.toContain("idle");
    // 6: the missing card is open.
    expect((await openCard(db, missing))?.field).toBe("deviceModel");
    // 7: only the old orphan is gone.
    expect((await listFiles(db.pool, uploads)).map((f) => f.id).sort()).toEqual([kept.id, fresh.id].sort());

    // Idempotent: nothing left to fix (the sweeper's start is the only repeated work).
    const again = capture();
    const second = recover(again.log);
    const report2 = await second.run();
    await second.sweeper.stop();
    expect(report2).toMatchObject({ danglingCalls: 0, leasesReclaimed: 0, overdueTimers: 0, orphanUploads: 0 });
  });

  it("a failing session does not stop the others", async () => {
    const good = await seedSession(db.pool);
    const bad = await seedSession(db.pool);
    for (const [id, prefix] of [[good, "g"], [bad, "b"]] as const) {
      await insertCall(db.pool, { id: `${prefix}${id.slice(0, 8)}`, sessionId: id });
      await db.pool.query("UPDATE sessions SET active_call_id = $2 WHERE id = $1", [id, `${prefix}${id.slice(0, 8)}`]);
    }
    const failing = testServices(db, {
      failpoint: () => {
        throw new Error("boom");
      },
    });
    const { log, lines } = capture();
    const sweeper = new Sweeper({ pool: db.pool, processor: failing.processor, log });
    // Every EndCall through the failing processor rolls back (the dispatch throws), so nothing is half-ended.
    const report = await recoverOnBoot({ pool: db.pool, processor: failing.processor, sweeper, log });
    await sweeper.stop();
    expect(lines.filter((l) => l.level === "error" && l.msg === "recovery: could not end a dangling call").length).toBeGreaterThanOrEqual(2);
    expect(report.danglingCalls).toBe(0);
    // A later recovery with a working processor still repairs them.
    const { sweeper: s2, run } = recover(createLogger("silent"));
    const fixed = await run();
    await s2.stop();
    expect(fixed.danglingCalls).toBeGreaterThanOrEqual(2);
  });
});

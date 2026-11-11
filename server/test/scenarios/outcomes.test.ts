// The four outcomes through the real user paths, revisions, reopening and the closed state (P7-T01, P7-T02, P7-T05).
// "Real user paths": every answer is a SubmitChatInput command (what the chat socket sends), the Stop button is
// OptOutRequested, a call is StartCall/EndCall, and the idle and expiry timers are TimerFired commands for timers that
// are really due in the database: nothing calls Finalize directly (that is the token-gated test API, tested apart).
import { Outcome } from "@device-repair/shared/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/pool.js";
import { listEvents } from "../../src/db/repos/events.js";
import { listOutbox } from "../../src/db/repos/outbox.js";
import { listRecords } from "../../src/db/repos/records.js";
import { getSession } from "../../src/db/repos/sessions.js";
import { listInputRequests } from "../../src/db/repos/inputRequests.js";
import { upsertTimer } from "../../src/db/repos/timers.js";
import { validateRecord } from "../../src/domain/record.js";
import type { SessionServices } from "../../src/session/services.js";
import { FAKE_SECRET_VALUES } from "../fixtures.js";
import { answer, answerOpen, ANSWERS, openCard, sessionAtField, storeTestFile } from "../helpers/chatFlow.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { expectSanitizedRecord } from "../helpers/recordOracle.js";
import { testServices } from "../helpers/session.js";

let schema: TestSchema;
let db: Database;
let services: SessionServices;
let manual: SessionServices; // AUTO_COMPLETE_ON_IDLE=false

beforeAll(async () => {
  ({ schema, db } = await createMigratedSchema("outcomes", { max: 10 }));
  services = testServices(db, { planner: true });
  manual = testServices(db, { planner: true, autoCompleteOnIdle: false });
});
afterAll(async () => {
  await schema.drop();
});

const run = <R = unknown>(id: string, command: object, via = services) => via.processor.dispatch<R>(id, command as never);
const dueNow = () => new Date(Date.now() - 1000);

/** The idle timer fires (it is due), as the sweeper would dispatch it. */
async function idle(id: string, via = services) {
  await upsertTimer(db.pool, { sessionId: id, kind: "idle", dueAt: dueNow() });
  return run<{ fired: boolean; finalized?: { revision: number; outcome: string; unchanged?: boolean } }>(id, { type: "TimerFired", kind: "idle", dueAt: new Date() }, via);
}
const yes = (id: string, field = "submitConfirmation") => answerOpen(db, services, id, field, true);
const types = async (id: string) => (await listEvents(db.pool, id)).map((e) => e.type);
const count = async (id: string, type: string) => (await types(id)).filter((t) => t === type).length;

/** Answers the cards from the one open now through the end of the flow, up to (not including) Submit claim?. */
async function finishCards(id: string): Promise<void> {
  for (let i = 0; i < 12; i++) {
    const open = await openCard(db, id);
    if (!open || open.field === "submitConfirmation") return;
    const value = open.field === "purchaseInvoice" ? `file:${(await storeTestFile(db, id)).id}` : ANSWERS[open.field];
    await answer(services, id, open.id, open.field, value);
  }
}

describe("each outcome through a real user path", () => {
  it("completed: Yes on Submit claim?", async () => {
    const id = await sessionAtField(db, services, "submitConfirmation");
    expect(await yes(id)).toMatchObject({ status: "accepted", finalized: { revision: 1, outcome: Outcome.COMPLETED } });
    const [record] = await listRecords(db.pool, id);
    expect(record?.payload).toMatchObject({ outcome: "completed", revision: 1, previousRevision: null, submitConfirmation: { confirmed: true, source: "chat" } });
    validateRecord(record?.payload);
    expectSanitizedRecord(record?.payload, { secrets: FAKE_SECRET_VALUES });
    expect(await getSession(db.pool, id)).toMatchObject({ status: "finalized", outcome: "completed", currentRevision: 1 });
  });

  it("optedOut: the Stop flow, confirmed", async () => {
    const id = await sessionAtField(db, services, "serialNumber");
    await run(id, { type: "OptOutRequested" });
    expect(await answerOpen(db, services, id, "optOutConfirmation", true)).toMatchObject({ finalized: { revision: 1, outcome: Outcome.OPTED_OUT } });
    expect((await listRecords(db.pool, id))[0]?.payload).toMatchObject({ outcome: "optedOut", submitConfirmation: null });
    expect(await openCard(db, id)).toBeNull(); // every card cancelled
  });

  it("partial: the idle timer with required fields missing; the open card is kept for the returning user", async () => {
    const id = await sessionAtField(db, services, "email");
    expect((await idle(id)).reply).toMatchObject({ fired: true, finalized: { revision: 1, outcome: Outcome.PARTIAL } });
    const [record] = await listRecords(db.pool, id);
    expect(record?.payload).toMatchObject({ outcome: "partial", missingRequired: ["email"] });
    expect(String(record?.payload.outcomeReason)).toMatch(/idle timeout with required fields missing/);
    expect((await openCard(db, id))?.field).toBe("email");
    expect(await getSession(db.pool, id)).toMatchObject({ status: "finalized", outcome: "partial" });
  });

  it("needsReview: a safety flag raised on the call, then the user's Yes (R-1)", async () => {
    const id = await sessionAtField(db, services, "submitConfirmation");
    await run(id, { type: "FlagForReview", kind: "safety", reason: "battery is swelling" });
    expect(await yes(id)).toMatchObject({ finalized: { outcome: Outcome.NEEDS_REVIEW } });
    const [record] = await listRecords(db.pool, id);
    expect(record?.payload.reviewFlags).toEqual([{ rule: "R-1", reason: "battery is swelling" }]);
  });

  it("needsReview: a required field still invalid after 3 attempts, then the idle timer (R-3)", async () => {
    const id = await sessionAtField(db, services, "email");
    for (let i = 0; i < 3; i++) await answerOpen(db, services, id, "email", "not an email");
    expect((await idle(id)).reply).toMatchObject({ finalized: { outcome: Outcome.NEEDS_REVIEW } });
    expect((await listRecords(db.pool, id))[0]?.payload.reviewFlags).toEqual([expect.objectContaining({ rule: "R-3" })]);
  });
});

describe("the idle timer on a session that has everything but the confirmation (D16)", () => {
  it("AUTO_COMPLETE_ON_IDLE=true: completed, saying it wasn't confirmed", async () => {
    const id = await sessionAtField(db, services, "submitConfirmation");
    expect((await idle(id)).reply).toMatchObject({ finalized: { outcome: Outcome.COMPLETED } });
    expect((await listRecords(db.pool, id))[0]?.payload).toMatchObject({ outcome: "completed", outcomeReason: "auto-finalized after inactivity; not explicitly confirmed", submitConfirmation: null });
  });

  it("AUTO_COMPLETE_ON_IDLE=false: partial, and the Submit card stays open to continue", async () => {
    const id = await sessionAtField(db, manual, "submitConfirmation");
    expect((await idle(id, manual)).reply).toMatchObject({ finalized: { outcome: Outcome.PARTIAL } });
    expect((await openCard(db, id))?.field).toBe("submitConfirmation");
    // Returning and tapping Yes reopens and completes in the same command (revision 2).
    expect(await answerOpen(db, manual, id, "submitConfirmation", true)).toMatchObject({ finalized: { revision: 2, outcome: Outcome.COMPLETED } });
    expect((await listRecords(db.pool, id)).map((r) => [r.revision, r.outcome])).toEqual([[1, "partial"], [2, "completed"]]);
  });

  it("the idle timer never fires finalization during a call, nor on a finalized session", async () => {
    const id = await sessionAtField(db, services, "email");
    await run(id, { type: "StartCall", callId: `c${id.slice(0, 8)}` });
    expect((await idle(id)).reply).toEqual({ fired: false, reason: "callActive" });
    expect(await listRecords(db.pool, id)).toEqual([]);
  });
});

describe("simultaneous triggers are serialized: one record", () => {
  it("Yes and the idle timer at the same moment give exactly one revision and one outbox row", async () => {
    for (let round = 0; round < 5; round++) {
      const id = await sessionAtField(db, services, "submitConfirmation");
      const open = await openCard(db, id);
      await upsertTimer(db.pool, { sessionId: id, kind: "idle", dueAt: dueNow() });
      await Promise.all([
        answer(services, id, open?.id ?? "", "submitConfirmation", true),
        run(id, { type: "TimerFired", kind: "idle", dueAt: new Date() }),
        run(id, { type: "Finalize", trigger: "testFinalize" }),
      ]);
      expect((await listRecords(db.pool, id)).map((r) => r.revision), `round ${round}`).toEqual([1]);
      expect(await listOutbox(db.pool, id)).toHaveLength(1);
      expect(await count(id, "session.finalized")).toBe(1);
    }
  });
});

describe("revisions (P7-T02)", () => {
  it("every revision queues its delivery in the same transaction", async () => {
    const id = await sessionAtField(db, services, "email");
    await idle(id);
    expect(await listOutbox(db.pool, id)).toMatchObject([{ revision: 1, target: "webhook", status: "pending", attempts: 0 }]);
  });

  it("a crash before COMMIT leaves no record, no outbox row, no event and the session active", async () => {
    const crashing = testServices(db, {
      planner: true,
      failpoint: (name) => {
        if (name === "beforeCommit") throw new Error("simulated crash");
      },
    });
    const id = await sessionAtField(db, services, "email");
    const before = await types(id);
    await upsertTimer(db.pool, { sessionId: id, kind: "idle", dueAt: dueNow() });
    await expect(run(id, { type: "TimerFired", kind: "idle", dueAt: new Date() }, crashing)).rejects.toThrow("simulated crash");
    expect(await listRecords(db.pool, id)).toEqual([]);
    expect(await listOutbox(db.pool, id)).toEqual([]);
    expect(await types(id)).toEqual(before);
    expect(await getSession(db.pool, id)).toMatchObject({ status: "active", currentRevision: 0 });
    // The timer is still there, so the next attempt (after the "restart") produces the record exactly once.
    expect((await idle(id)).reply).toMatchObject({ finalized: { revision: 1 } });
    expect(await listRecords(db.pool, id)).toHaveLength(1);
  });

  it("a returning user whose claim hasn't changed gets no new revision: the session just finalizes again", async () => {
    const id = await sessionAtField(db, services, "email");
    await idle(id); // partial rev 1
    const first = (await listRecords(db.pool, id))[0];
    // The user calls back, says nothing new and leaves: activity, but the claim is the same.
    const callId = `c${id.slice(0, 8)}`;
    await run(id, { type: "StartCall", callId });
    expect(await getSession(db.pool, id)).toMatchObject({ status: "active", currentRevision: 1 });
    await run(id, { type: "EndCall", callId, reason: "hangup" });
    const again = await idle(id);
    expect(again.reply).toMatchObject({ finalized: { revision: 1, outcome: Outcome.PARTIAL, unchanged: true } });
    expect(await listRecords(db.pool, id)).toHaveLength(1);
    expect(await listOutbox(db.pool, id)).toHaveLength(1);
    expect(await getSession(db.pool, id)).toMatchObject({ status: "finalized", currentRevision: 1 });
    expect((await listRecords(db.pool, id))[0]?.contentHash).toBe(first?.contentHash);
    const last = (await listEvents(db.pool, id)).filter((e) => e.type === "session.finalized").at(-1);
    expect(await count(id, "session.finalized")).toBe(2); // the second finalization is on the timeline, marked unchanged
    expect(last?.payload).toMatchObject({ unchanged: true, revision: 1 });
  });

  it("a returning user whose answer changed the claim gets revision 2 (an invalid answer is a change: the field is no longer just missing)", async () => {
    const id = await sessionAtField(db, services, "email");
    await idle(id);
    await answerOpen(db, services, id, "email", "nope");
    expect((await idle(id)).reply).toMatchObject({ finalized: { revision: 2, outcome: Outcome.PARTIAL } });
    expect((await listRecords(db.pool, id)).map((r) => r.revision)).toEqual([1, 2]);
  });
});

describe("reopening (P7-T05)", () => {
  it("partial rev 1 → the user answers the kept card → completed rev 2; rev 1 is byte-identical afterwards", async () => {
    const id = await sessionAtField(db, services, "email");
    await idle(id);
    const rev1 = await db.pool.query<{ payload: string; content_hash: string; created_at: Date }>("SELECT payload::text, content_hash, created_at FROM records WHERE session_id = $1 AND revision = 1", [id]);

    expect(await answerOpen(db, services, id, "email", "asha.rao@example.com")).toEqual({ status: "accepted" });
    expect(await getSession(db.pool, id)).toMatchObject({ status: "active" });
    expect((await listEvents(db.pool, id)).find((e) => e.type === "session.reopened")?.payload).toMatchObject({ activity: "chatInput", previousOutcome: "partial", revision: 1 });
    await finishCards(id);
    expect(await yes(id)).toMatchObject({ finalized: { revision: 2, outcome: Outcome.COMPLETED } });

    const records = await listRecords(db.pool, id);
    expect(records.map((r) => [r.revision, r.outcome])).toEqual([[1, "partial"], [2, "completed"]]);
    expect(records[1]?.payload).toMatchObject({ previousRevision: { revision: 1, outcome: "partial" }, missingRequired: [] });
    expect((await listOutbox(db.pool, id)).map((o) => [o.revision, o.status])).toEqual([[1, "pending"], [2, "pending"]]);
    const after = await db.pool.query<{ payload: string; content_hash: string; created_at: Date }>("SELECT payload::text, content_hash, created_at FROM records WHERE session_id = $1 AND revision = 1", [id]);
    expect(after.rows[0]).toEqual(rev1.rows[0]);
    expect(await count(id, "session.reopened")).toBe(1);
  });

  it("a stale answer does not reopen; a chat reconnect (just replaying) does not reopen", async () => {
    const id = await sessionAtField(db, services, "email");
    await idle(id);
    // A card that isn't the open one: stale, nothing written, still finalized.
    expect(await answer(services, id, "req_nope_1", "email", "asha.rao@example.com")).toMatchObject({ status: "stale" });
    // A reconnect: the chat socket's connect-time reconcile and replay.
    await services.processor.react(id);
    expect(await getSession(db.pool, id)).toMatchObject({ status: "finalized" });
    expect(await count(id, "session.reopened")).toBe(0);
    expect(await listRecords(db.pool, id)).toHaveLength(1);
  });

  it("completed + a new call: reopens; the earlier Yes no longer counts, so the planner asks again and the idle timer says unconfirmed", async () => {
    const id = await sessionAtField(db, services, "submitConfirmation");
    await yes(id);
    const callId = `c${id.slice(0, 8)}`;
    expect((await run(id, { type: "StartCall", callId })).reply).toEqual({ status: "started", returning: false });
    expect(await getSession(db.pool, id)).toMatchObject({ status: "active", activeCallId: callId });
    expect((await listEvents(db.pool, id)).find((e) => e.type === "session.reopened")?.payload).toMatchObject({ activity: "callStarted", previousOutcome: "completed" });
    await run(id, { type: "EndCall", callId, reason: "hangup" });
    // Everything valid, but the confirmation was before the reopen: Submit claim? comes back.
    expect(await openCard(db, id)).toMatchObject({ field: "submitConfirmation", id: "req_submitConfirmation_2" });
    expect((await idle(id)).reply).toMatchObject({ finalized: { revision: 2, outcome: Outcome.COMPLETED } });
    expect((await listRecords(db.pool, id))[1]?.payload).toMatchObject({ outcomeReason: "auto-finalized after inactivity; not explicitly confirmed", submitConfirmation: null, previousRevision: { revision: 1, outcome: "completed" } });
  });

  it("completed + a new call + Yes again: the new confirmation is part of the claim (revision 2), unless nothing at all differs (the same instant)", async () => {
    let now = Date.now();
    const timed = testServices(db, { planner: true, now: () => new Date(now) });
    const yesTimed = (id: string) => answerOpen(db, timed, id, "submitConfirmation", true);
    const recall = async (id: string) => {
      const callId = `c${id.slice(0, 8)}${now}`.slice(0, 20);
      await run(id, { type: "StartCall", callId }, timed);
      await run(id, { type: "EndCall", callId, reason: "hangup" }, timed);
    };

    const later = await sessionAtField(db, timed, "submitConfirmation");
    await yesTimed(later);
    now += 60_000;
    await recall(later);
    expect(await yesTimed(later)).toMatchObject({ finalized: { revision: 2, outcome: Outcome.COMPLETED } });
    const [one, two] = await listRecords(db.pool, later);
    const confirmedAt = (r?: { payload: Record<string, unknown> }) => (r?.payload.submitConfirmation as { at: string } | null)?.at ?? "";
    expect(confirmedAt(two) > confirmedAt(one)).toBe(true);
    expect(confirmedAt(one)).not.toBe("");
    expect(two?.payload).toMatchObject({ engagement: { calls: 1 }, previousRevision: { revision: 1, outcome: "completed" } });

    const same = await sessionAtField(db, timed, "submitConfirmation");
    await yesTimed(same);
    await recall(same); // no time passes
    expect(await yesTimed(same)).toMatchObject({ finalized: { revision: 1 } });
    expect(await listRecords(db.pool, same)).toHaveLength(1);
  });
});

describe("opted out: Resume your claim? first (P7-T05)", () => {
  async function optedOutSession(): Promise<string> {
    const id = await sessionAtField(db, services, "serialNumber");
    await run(id, { type: "OptOutRequested" });
    await answerOpen(db, services, id, "optOutConfirmation", true);
    return id;
  }
  const resumeCards = async (id: string) => (await listInputRequests(db.pool, id)).filter((r) => r.field === "resumeConfirmation");

  it("a call is refused and the chat gets the card, once; No keeps the session opted out with no new revision", async () => {
    const id = await optedOutSession();
    expect((await run(id, { type: "StartCall", callId: `c${id.slice(0, 8)}` })).reply).toEqual({ status: "refused", reason: "resumeRequired" });
    expect(await openCard(db, id)).toMatchObject({ field: "resumeConfirmation", id: "req_resumeConfirmation_1" });
    expect((await run(id, { type: "StartCall", callId: `d${id.slice(0, 8)}` })).reply).toEqual({ status: "refused", reason: "resumeRequired" });
    expect(await resumeCards(id)).toHaveLength(1); // not a second card

    expect(await answerOpen(db, services, id, "resumeConfirmation", false)).toEqual({ status: "accepted" });
    expect(await getSession(db.pool, id)).toMatchObject({ status: "finalized", outcome: "optedOut", currentRevision: 1 });
    expect(await count(id, "session.reopened")).toBe(0);
    expect(await listRecords(db.pool, id)).toHaveLength(1);
    expect(await listOutbox(db.pool, id)).toHaveLength(1);
  });

  it("Yes reopens: the planner carries on where it left off and the next record is revision 2 pointing at the opt-out", async () => {
    const id = await optedOutSession();
    await run(id, { type: "StartCall", callId: `c${id.slice(0, 8)}` });
    expect(await answerOpen(db, services, id, "resumeConfirmation", true)).toEqual({ status: "accepted" });
    expect(await getSession(db.pool, id)).toMatchObject({ status: "active" });
    expect((await listEvents(db.pool, id)).find((e) => e.type === "session.reopened")?.payload).toMatchObject({ activity: "resumeConfirmed", previousOutcome: "optedOut" });
    expect((await openCard(db, id))?.field).toBe("serialNumber"); // where it left off
    expect((await run(id, { type: "StartCall", callId: `e${id.slice(0, 8)}` })).reply).toEqual({ status: "started", returning: false });
    await run(id, { type: "EndCall", callId: `e${id.slice(0, 8)}`, reason: "hangup" });
    await idle(id);
    const records = await listRecords(db.pool, id);
    expect(records.map((r) => [r.revision, r.outcome])).toEqual([[1, "optedOut"], [2, "partial"]]);
    expect(records[1]?.payload).toMatchObject({ previousRevision: { revision: 1, outcome: "optedOut" } });
  });

  it("an answer to any other card does not reopen an opted-out session", async () => {
    const id = await optedOutSession();
    expect(await answer(services, id, "req_serialNumber_1", "serialNumber", "352099001761481")).toMatchObject({ status: "stale" });
    expect(await getSession(db.pool, id)).toMatchObject({ status: "finalized", outcome: "optedOut" });
  });
});

describe("closed (PD3a)", () => {
  const expire = async (id: string) => {
    await upsertTimer(db.pool, { sessionId: id, kind: "sessionExpiry", dueAt: dueNow() });
    return run<{ fired: boolean; closed?: boolean; finalized?: { revision: number } }>(id, { type: "TimerFired", kind: "sessionExpiry", dueAt: new Date() });
  };

  it("a pending finalization runs first, then the session closes; submitting or calling afterwards reopens nothing", async () => {
    const id = await sessionAtField(db, services, "email");
    expect((await expire(id)).reply).toMatchObject({ fired: true, closed: true, finalized: { revision: 1 } });
    expect(await getSession(db.pool, id)).toMatchObject({ status: "closed", outcome: "partial", currentRevision: 1 });
    expect(await openCard(db, id)).toBeNull(); // the kept card is cancelled with the session
    expect(await listOutbox(db.pool, id)).toHaveLength(1);

    expect(await answer(services, id, "req_email_1", "email", "asha.rao@example.com")).toMatchObject({ status: "stale" });
    expect((await run(id, { type: "StartCall", callId: `c${id.slice(0, 8)}` })).reply).toEqual({ status: "refused", reason: "closed" });
    expect(await count(id, "session.reopened")).toBe(0);
    expect(await listRecords(db.pool, id)).toHaveLength(1);
    expect((await idle(id)).reply).toMatchObject({ fired: false }); // nothing fires on a closed session
  });

  it("a finalized session closes without a new revision", async () => {
    const id = await sessionAtField(db, services, "submitConfirmation");
    await yes(id);
    expect((await expire(id)).reply).toEqual({ fired: true, closed: true });
    expect(await getSession(db.pool, id)).toMatchObject({ status: "closed", outcome: "completed", currentRevision: 1 });
    expect(await listRecords(db.pool, id)).toHaveLength(1);
    expect((await expire(id)).reply).toMatchObject({ fired: false }); // already closed: the timer just goes
  });
});

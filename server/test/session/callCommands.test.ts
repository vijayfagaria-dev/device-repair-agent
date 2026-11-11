// The call's commands (P5-T02/T05/T06) against the throwaway test Postgres.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/pool.js";
import { listCalls } from "../../src/db/repos/calls.js";
import { listEvents } from "../../src/db/repos/events.js";
import { listFieldCandidates } from "../../src/db/repos/fieldCandidates.js";
import { listRecords } from "../../src/db/repos/records.js";
import { getSession } from "../../src/db/repos/sessions.js";
import { listTimers, upsertTimer } from "../../src/db/repos/timers.js";
import type { SessionServices } from "../../src/session/services.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { seedSession } from "../helpers/seed.js";
import { testServices } from "../helpers/session.js";

let schema: TestSchema;
let db: Database;
let services: SessionServices;
beforeAll(async () => {
  ({ schema, db } = await createMigratedSchema("callcmd"));
  services = testServices(db);
});
afterAll(async () => {
  await schema.drop();
});

const run = async <R>(id: string, command: object) => (await services.processor.dispatch<R>(id, command as never)).reply as R;
async function inCall(id: string, callId = `c${id.slice(0, 6)}`) {
  await run(id, { type: "StartCall", callId });
  return callId;
}

describe("StartCall / EndCall", () => {
  it("start: a calls row, activeCallId, call.started, noCallStart cleared, user activity; a second start is refused", async () => {
    const id = await seedSession(db.pool);
    await upsertTimer(db.pool, { sessionId: id, kind: "noCallStart", dueAt: new Date(Date.now() + 60_000) });
    expect(await run(id, { type: "StartCall", callId: "cA" })).toEqual({ status: "started", returning: false });
    expect((await getSession(db.pool, id))?.activeCallId).toBe("cA");
    expect((await listCalls(db.pool, id)).map((c) => c.id)).toEqual(["cA"]);
    expect((await listTimers(db.pool, id)).map((t) => t.kind)).toEqual(["sessionExpiry"]);
    expect(await run(id, { type: "StartCall", callId: "cB" })).toEqual({ status: "refused", reason: "active" });
  });

  it("end: exactly once (only the active call), the row ended with its reason, idle re-armed; the next start is a returning call", async () => {
    const id = await seedSession(db.pool);
    const callId = await inCall(id);
    expect(await run(id, { type: "EndCall", callId, reason: "hangup" })).toMatchObject({ status: "ended" });
    expect(await run(id, { type: "EndCall", callId, reason: "network" })).toEqual({ status: "notActive" });
    expect((await listEvents(db.pool, id)).filter((e) => e.type === "call.ended").map((e) => e.payload.reason)).toEqual(["hangup"]);
    expect((await listCalls(db.pool, id))[0]).toMatchObject({ endReason: "hangup" });
    expect((await listTimers(db.pool, id)).map((t) => t.kind).sort()).toEqual(["idle", "sessionExpiry"]);
    expect(await run(id, { type: "StartCall", callId: "c2" })).toEqual({ status: "started", returning: true });
  });

  it("ends the user didn't choose leave a reason-specific chat note; a hang-up leaves it to the planner's lead-in (P5-T09)", async () => {
    const notes: Record<string, string | null> = {};
    for (const reason of ["hangup", "agent_ended", "network", "silence", "max_duration", "provider_error", "server_restart"]) {
      const id = await seedSession(db.pool);
      const callId = await inCall(id);
      await run(id, { type: "EndCall", callId, reason });
      const message = (await listEvents(db.pool, id)).find((e) => e.type === "chat.message")?.payload.message as { text: string } | undefined;
      notes[reason] = message?.text ?? null;
    }
    expect(notes).toEqual({
      hangup: null,
      agent_ended: null,
      network: "The call dropped. Let's continue here in chat.",
      silence: "I didn't hear anything for a while, so I ended the call. Let's continue here in chat.",
      max_duration: "We reached the time limit for a call. Let's finish here in chat.",
      provider_error: "I'm having trouble with the voice line, so let's continue here in chat.",
      server_restart: "The call was interrupted; let's continue here.",
    });
  });

  it("a closed session can't take a call", async () => {
    const id = await seedSession(db.pool);
    await db.pool.query("UPDATE sessions SET status = 'closed' WHERE id = $1", [id]);
    expect(await run(id, { type: "StartCall", callId: "cX" })).toEqual({ status: "refused", reason: "closed" });
  });
});

describe("AppendTranscript", () => {
  it("stores a final line for a call of this session; refuses an unknown call or an empty line", async () => {
    const id = await seedSession(db.pool);
    const callId = await inCall(id);
    expect(await run(id, { type: "AppendTranscript", line: { id: `tu_${callId}_1`, callId, role: "user", text: "Hello", startedAt: new Date() } })).toEqual({ appended: true });
    expect(await run(id, { type: "AppendTranscript", line: { id: "tu_nope_1", callId: "nope", role: "user", text: "Hi", startedAt: new Date() } })).toEqual({ appended: false });
    expect(await run(id, { type: "AppendTranscript", line: { id: `tu_${callId}_2`, callId, role: "user", text: "  ", startedAt: new Date() } })).toEqual({ appended: false });
  });
});

describe("SaveSpokenField: code decides, never the model (D13, D14)", () => {
  const save = (id: string, field: string, value: string, evidence = value, extra: object = {}) => run<Record<string, unknown>>(id, { type: "SaveSpokenField", field, value, evidence, ...extra });

  it("a call field is validated and stored as a valid call candidate, with the evidence kept in its row only", async () => {
    const id = await seedSession(db.pool);
    await inCall(id);
    expect(await save(id, "deviceModel", "Samsung Galaxy S23", "it's a Samsung Galaxy S23")).toEqual({ status: "valid", normalized: { brand: "Samsung", model: "Galaxy S23" } });
    const [candidate] = await listFieldCandidates(db.pool, id, "deviceModel");
    expect(candidate).toMatchObject({ source: "call", status: "valid", evidence: "it's a Samsung Galaxy S23" });
    const event = (await listEvents(db.pool, id)).find((e) => e.type === "field.candidate");
    expect(JSON.stringify(event?.payload)).not.toContain("evidence");
  });

  it("an identifier heard aloud is only `unverified`, even when it's valid; an invalid one is invalid", async () => {
    const id = await seedSession(db.pool);
    await inCall(id);
    expect(await save(id, "email", "asha@example.com", "asha at example dot com")).toEqual({ status: "unverified", normalized: "asha@example.com" });
    expect(await save(id, "serialNumber", "1234")).toMatchObject({ status: "invalid" });
    expect((await listFieldCandidates(db.pool, id)).map((c) => [c.field, c.status])).toEqual([
      ["email", "unverified"],
      ["serialNumber", "invalid"],
    ]);
  });

  it("dates come from the customer's words, not the model's value", async () => {
    const id = await seedSession(db.pool);
    await inCall(id);
    expect(await save(id, "problemStartedAt", "2049-01-01", "tomorrow")).toMatchObject({ status: "invalid" });
    const yesterday = await save(id, "problemStartedAt", "2049-01-01", "yesterday");
    expect(yesterday).toMatchObject({ status: "valid", normalized: { precision: "day", spoken: "yesterday" } });
  });

  it("'don't know' for the model is asked once more, then accepted as unknown; non-spoken fields and finished sessions are refused", async () => {
    const id = await seedSession(db.pool);
    await inCall(id);
    expect(await save(id, "deviceModel", "I don't know")).toMatchObject({ status: "invalid" });
    expect(await save(id, "deviceModel", "I don't know")).toEqual({ status: "valid", normalized: { brand: null, model: null } });
    expect(await save(id, "purchaseInvoice", "invoice.pdf")).toEqual({ status: "refused", reason: "notSpoken" });
    await db.pool.query("UPDATE sessions SET status = 'finalized', outcome = 'partial' WHERE id = $1", [id]);
    expect(await save(id, "urgency", "high")).toEqual({ status: "refused", reason: "notActive" });
  });
});

describe("FlagForReview and OptOutByCall", () => {
  it("a safety flag is R-1, anything else R-5; the same flag twice is stored once", async () => {
    const id = await seedSession(db.pool);
    expect(await run(id, { type: "FlagForReview", kind: "safety", reason: "battery is swelling" })).toEqual({ status: "flagged" });
    expect(await run(id, { type: "FlagForReview", kind: "safety", reason: "battery is swelling" })).toEqual({ status: "alreadyFlagged" });
    await run(id, { type: "FlagForReview", kind: "other", reason: "customer disputes the warranty" });
    expect((await getSession(db.pool, id))?.reviewFlags).toEqual([
      { rule: "R-1", reason: "battery is swelling" },
      { rule: "R-5", reason: "customer disputes the warranty" },
    ]);
  });

  it("an opt-out on the call produces the optedOut record, revision 1, with what was collected", async () => {
    const id = await seedSession(db.pool);
    await inCall(id);
    await run(id, { type: "SaveSpokenField", field: "deviceType", value: "laptop", evidence: "a laptop" });
    expect(await run(id, { type: "OptOutByCall" })).toEqual({ status: "optedOut", revision: 1 });
    const [record] = await listRecords(db.pool, id);
    expect(record?.payload).toMatchObject({ outcome: "optedOut", revision: 1, fields: { deviceType: { value: "laptop", source: "call", status: "valid" } }, engagement: { calls: 1 } });
    expect((await listEvents(db.pool, id)).map((e) => e.type)).toContain("optout.confirmed");
    expect(await run(id, { type: "OptOutByCall" })).toMatchObject({ status: "refused" });
  });
});

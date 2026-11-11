// Finalization (P6-T01) against the throwaway test Postgres: each trigger yields a schema-valid record with the
// expected outcome, in one transaction with the session update and the event; cost comes from the usage ledger and
// engagement from calls, messages and attempts; a record that fails its schema becomes needsReview (R-5).
import { RECORD_FIELD_IDS, type RecordFieldId } from "@device-repair/shared/fields";
import { Outcome } from "@device-repair/shared/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/pool.js";
import { listEvents } from "../../src/db/repos/events.js";
import { listRecords } from "../../src/db/repos/records.js";
import { getSession } from "../../src/db/repos/sessions.js";
import { listTimers, upsertTimer } from "../../src/db/repos/timers.js";
import { FIELDS } from "../../src/domain/fields.js";
import { buildRecord, RecordSchemaError, validateRecord } from "../../src/domain/record.js";
import { recordUsage } from "../../src/metrics/usage.js";
import { finalizeEffects, finalizeHandler, finalizePrepare, type FinalizeReply } from "../../src/session/handlers/finalize.js";
import type { SessionUpdate } from "../../src/session/hub.js";
import type { SessionServices } from "../../src/session/services.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { seedSession } from "../helpers/seed.js";
import { endSeededCall, seedCall, TEST_SIGNER, testServices } from "../helpers/session.js";
import { FILE, VALID_VALUES } from "../domain/helpers.js";
import { FAKE_SECRET_VALUES } from "../fixtures.js";
import { expectSanitizedRecord } from "../helpers/recordOracle.js";

let schema: TestSchema;
let db: Database;
let services: SessionServices;

beforeAll(async () => {
  ({ schema, db } = await createMigratedSchema("finalize"));
  services = testServices(db);
});
afterAll(async () => {
  await schema.drop();
});

const run = <R = unknown>(id: string, command: object) => services.processor.dispatch<R>(id, command as never);
const CHAT = new Set<string>(["serialNumber", "purchaseInvoice", "serviceCentre", "email", "additionalPhotos", "additionalNotes"]);

/** A valid candidate for each field given, as the validators would have stored it. */
async function collect(id: string, fields: readonly RecordFieldId[]): Promise<void> {
  for (const field of fields) {
    await run(id, { type: "Test.Candidate", field, source: CHAT.has(field) ? "chat" : "call", raw: "x", normalized: VALID_VALUES[field], status: "valid" });
  }
}
const REQUIRED = RECORD_FIELD_IDS.filter((field) => FIELDS[field].required);
/** The user's Yes on "Submit claim?", as SubmitChatInput stores it. */
const confirmYes = (id: string) => run(id, { type: "Test.Candidate", field: "submitConfirmation", source: "chat", raw: true, normalized: true, status: "valid" });
/** Every required field, then Yes. */
const ready = async (id: string) => {
  await collect(id, REQUIRED);
  await confirmYes(id);
};

describe("Finalize: one schema-valid record per trigger (the four outcomes)", () => {
  const cases: { name: string; setup: (id: string) => Promise<void>; trigger: string; outcome: Outcome; reason: RegExp }[] = [
    { name: "completed", setup: ready, trigger: "confirmSubmit", outcome: Outcome.COMPLETED, reason: /user confirmed submission/ },
    { name: "partial", setup: (id) => collect(id, ["deviceType", "deviceModel"]), trigger: "testFinalize", outcome: Outcome.PARTIAL, reason: /required fields missing: problemDescription/ },
    { name: "optedOut", setup: (id) => collect(id, ["deviceType"]), trigger: "optOutConfirmed", outcome: Outcome.OPTED_OUT, reason: /asked to stop/ },
    {
      name: "needsReview",
      setup: async (id) => {
        await ready(id);
        await db.pool.query(`UPDATE sessions SET review_flags = '[{"rule":"R-1","reason":"battery is swelling"}]' WHERE id = $1`, [id]);
      },
      trigger: "confirmSubmit",
      outcome: Outcome.NEEDS_REVIEW,
      reason: /R-1 battery is swelling/,
    },
  ];

  for (const { name, setup, trigger, outcome, reason } of cases) {
    it(`${trigger} → ${name}`, async () => {
      const id = await seedSession(db.pool);
      await setup(id);
      const published: SessionUpdate[] = [];
      const unsubscribe = services.hub.subscribe(id, (update) => published.push(update));
      const { reply } = await run<FinalizeReply>(id, { type: "Finalize", trigger });
      unsubscribe();
      expect(reply).toEqual({ finalized: true, revision: 1, outcome });

      const [record] = await listRecords(db.pool, id);
      expect(record?.revision).toBe(1);
      validateRecord(record?.payload);
      expectSanitizedRecord(record?.payload, { secrets: FAKE_SECRET_VALUES });
      expect(record?.payload).toMatchObject({ sessionId: id, revision: 1, outcome, previousRevision: null });
      expect(String(record?.payload.outcomeReason)).toMatch(reason);
      if (trigger === "confirmSubmit") expect(record?.payload.submitConfirmation).toMatchObject({ confirmed: true, source: "chat" });
      else expect(record?.payload.submitConfirmation).toBeNull();

      expect(await getSession(db.pool, id)).toMatchObject({ status: "finalized", outcome, currentRevision: 1 });
      const events = await listEvents(db.pool, id);
      expect(events.filter((e) => e.type === "session.finalized").map((e) => e.payload)).toEqual([
        { outcome, revision: 1, previousRevision: null, trigger, reason: record?.payload.outcomeReason, contentHash: record?.contentHash },
      ]);
      // The record travels on the update, never in an event payload (no signed URLs in the timeline).
      expect(published.at(-1)?.record).toEqual({ revision: 1, payload: record?.payload });
      expect(JSON.stringify(events.map((e) => e.payload))).not.toContain("sig=");
    });
  }

  it("a second Finalize is a no-op once the session is finalized (one revision, nothing written)", async () => {
    const id = await seedSession(db.pool);
    await ready(id);
    await run(id, { type: "Finalize", trigger: "confirmSubmit" });
    const before = await getSession(db.pool, id);
    const { reply, update } = await run<FinalizeReply>(id, { type: "Finalize", trigger: "confirmSubmit" });
    expect(reply).toEqual({ finalized: false, reason: "session is finalized" });
    expect(update).toBeNull();
    expect(await listRecords(db.pool, id)).toHaveLength(1);
    expect(await getSession(db.pool, id)).toEqual(before);
  });

  it("confirmSubmit with a required field missing writes nothing (D16: not possible)", async () => {
    const id = await seedSession(db.pool);
    await collect(id, ["deviceType"]);
    await confirmYes(id);
    const { reply, update } = await run<FinalizeReply>(id, { type: "Finalize", trigger: "confirmSubmit" });
    expect(reply).toMatchObject({ finalized: false, reason: expect.stringMatching(/^cannot confirm submission: required fields not valid/) });
    expect(update).toBeNull();
    expect(await listRecords(db.pool, id)).toEqual([]);
  });

  it("confirmSubmit without the user's Yes writes nothing: completed always carries its confirmation (PD2)", async () => {
    const id = await seedSession(db.pool);
    await collect(id, REQUIRED);
    const { reply, update } = await run<FinalizeReply>(id, { type: "Finalize", trigger: "confirmSubmit" });
    expect(reply).toEqual({ finalized: false, reason: "cannot confirm submission: the user hasn't tapped Yes on Submit claim?" });
    expect(update).toBeNull();
  });

  it("cancels the session's outstanding cards and clears noCallStart; adds the closing message", async () => {
    const id = await seedSession(db.pool);
    await upsertTimer(db.pool, { sessionId: id, kind: "noCallStart", dueAt: new Date(Date.now() + 60_000) });
    await run(id, { type: "Test.OpenCard", requestId: "req_email_1", field: "email" });
    const { update } = await run(id, { type: "Finalize", trigger: "optOutConfirmed" });
    expect(update?.events.map((e) => [e.type, e.payload.requestId ?? null])).toEqual([
      ["input.cancelled", "req_email_1"],
      ["session.finalized", null],
      ["chat.message", null],
    ]);
    expect(update?.events.at(-1)?.payload.message).toMatchObject({ role: "agent", text: "OK, I've stopped your claim. What you shared so far has been kept." });
    expect((await listTimers(db.pool, id)).map((t) => t.kind)).not.toContain("noCallStart");
    expect(update?.session.openRequestId).toBeNull();
  });
});

describe("what the record is built from", () => {
  it("cost is the usage ledger's (list-price equivalent); engagement counts calls, messages, answers and attempts", async () => {
    const id = await seedSession(db.pool);
    await recordUsage(db.pool, { sessionId: id, provider: "deepgram", kind: "nova-3:audio", units: 120 });
    await seedCall(db, id, `c${id.slice(0, 8)}`, new Date(Date.now() - 212_000));
    await endSeededCall(db, `c${id.slice(0, 8)}`, new Date());
    await ready(id);
    await run(id, { type: "Test.Say", messageId: `m1${id.slice(0, 6)}`, text: "hello" });
    await run(id, { type: "Test.OpenCard", requestId: "req_email_1", field: "email" });
    await run(id, { type: "Test.Reject", requestId: "req_email_1" });
    await run(id, { type: "Finalize", trigger: "confirmSubmit" });
    const [record] = await listRecords(db.pool, id);
    expectSanitizedRecord(record?.payload, { secrets: FAKE_SECRET_VALUES });
    expect(record?.payload.costUsd).toBeGreaterThan(0);
    expect(record?.payload.costBreakdownUsd).toMatchObject({ stt: record?.payload.costUsd, llm: 0, tts: 0, vision: 0 });
    expect(record?.payload.actualSpendUsd).toBe(0);
    expect(record?.payload.engagement).toEqual({
      calls: 1,
      callSeconds: 212,
      chatMessages: 2, // the test message and the closing message
      chatInputsSubmitted: REQUIRED.filter((f) => CHAT.has(f)).length + 1, // + the Yes
      invalidAttempts: 1,
    });
  });

  it("files become signed descriptors: the URL is the server's signed link for the file id", async () => {
    const id = await seedSession(db.pool);
    await ready(id);
    await run(id, { type: "Finalize", trigger: "confirmSubmit" });
    const [record] = await listRecords(db.pool, id);
    if (!record) throw new Error("no record");
    expectSanitizedRecord(record.payload, { secrets: FAKE_SECRET_VALUES });
    const invoice = (record.payload.fields as Record<string, { value: { url: string; fileId: string } } | undefined>).purchaseInvoice?.value;
    if (!invoice) throw new Error("no invoice in the record");
    expect(invoice.fileId).toBe(FILE.fileId);
    const url = new URL(invoice.url);
    expect(url.origin + url.pathname).toBe(`https://repair.example.com/files/${FILE.fileId}`);
    expect(TEST_SIGNER.check(FILE.fileId, url.searchParams.get("exp"), url.searchParams.get("sig"), new Date())).toBe("ok");
  });

  it("a record that fails its schema is rebuilt as needsReview with R-5 (D17), and the session keeps the flag", async () => {
    const id = await seedSession(db.pool);
    await ready(id);
    let first = true;
    const local = testServices(db);
    local.processor.register(
      "Test.FinalizeBroken",
      finalizeHandler({
        signFileUrl: TEST_SIGNER.sign,
        autoCompleteOnIdle: true,
        build: (input) => {
          if (first) {
            first = false;
            throw new RecordSchemaError([{ instancePath: "/fields/email/value", keyword: "maxLength", message: "too long" } as never]);
          }
          return buildRecord(input);
        },
      }) as never,
      { prepare: finalizePrepare },
    );
    const { reply, update } = await local.processor.dispatch<FinalizeReply>(id, { type: "Test.FinalizeBroken", trigger: "confirmSubmit" } as never);
    // The timeline keeps where it broke (paths and keywords only).
    expect(update?.events.find((e) => e.type === "session.finalized")?.payload.schemaProblems).toEqual([{ path: "/fields/email/value", keyword: "maxLength", message: "too long" }]);
    expect(reply).toEqual({ finalized: true, revision: 1, outcome: Outcome.NEEDS_REVIEW, schemaProblems: [{ path: "/fields/email/value", keyword: "maxLength", message: "too long" }] });
    const [record] = await listRecords(db.pool, id);
    expect(record?.payload.reviewFlags).toEqual([{ rule: "R-5", reason: "the record failed its schema" }]);
    expect((await getSession(db.pool, id))?.reviewFlags).toEqual([{ rule: "R-5", reason: "the record failed its schema" }]);
  });

  it("finalizeEffects refuses to run without the cost (a missing prepare step is a bug, not a $0 record)", async () => {
    const id = await seedSession(db.pool);
    const session = await getSession(db.pool, id);
    expect(() =>
      finalizeEffects(
        { session: session as never, lastSeq: 1, history: { chatMessages: 0, chatStarted: false, chatStalled: false, lastReopenedSeq: 0 }, timers: [], requests: [], candidates: [], calls: [], now: new Date() },
        { trigger: "testFinalize" },
        { signFileUrl: TEST_SIGNER.sign, autoCompleteOnIdle: true },
      ),
    ).toThrow(/needs the session cost/);
  });
});

describe("logging (P4 review #7, #8)", () => {
  /** A logger that keeps what was logged. */
  function captureLog() {
    const lines: { level: string; obj: Record<string, unknown>; msg: string }[] = [];
    const log: Record<string, unknown> = { level: "info" };
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal"]) log[level] = (obj: Record<string, unknown>, msg: string) => lines.push({ level, obj, msg });
    log.child = () => log;
    return { log: log as never, lines };
  }

  it("the record is logged without its signed file links", async () => {
    const { log, lines } = captureLog();
    const local = testServices(db, { log });
    const id = await seedSession(db.pool);
    for (const field of REQUIRED) {
      await local.processor.dispatch(id, { type: "Test.Candidate", field, source: CHAT.has(field) ? "chat" : "call", raw: "x", normalized: VALID_VALUES[field], status: "valid" } as never);
    }
    await local.processor.dispatch(id, { type: "Test.Candidate", field: "submitConfirmation", source: "chat", raw: true, normalized: true, status: "valid" } as never);
    await local.processor.dispatch(id, { type: "Finalize", trigger: "confirmSubmit" } as never);
    const produced = lines.find((l) => l.msg === "record produced");
    expect(produced?.obj.record).toMatchObject({ outcome: "completed", fields: { purchaseInvoice: { value: { fileId: FILE.fileId } } } });
    expect(JSON.stringify(produced?.obj)).not.toContain("sig=");
    expect(lines.filter((l) => l.level === "error")).toEqual([]);
  });

  it("a record that broke its schema is logged as an error with the paths only", async () => {
    const { log, lines } = captureLog();
    const local = testServices(db, { log });
    let first = true;
    local.processor.register(
      "Test.FinalizeBroken2",
      finalizeHandler({
        signFileUrl: TEST_SIGNER.sign,
        autoCompleteOnIdle: true,
        build: (input) => {
          if (first) {
            first = false;
            throw new RecordSchemaError([{ instancePath: "/fields/email/value", keyword: "maxLength", message: "too long" } as never]);
          }
          return buildRecord(input);
        },
      }) as never,
      { prepare: finalizePrepare },
    );
    const id = await seedSession(db.pool);
    await local.processor.dispatch(id, { type: "Test.FinalizeBroken2", trigger: "testFinalize" } as never);
    expect(lines.filter((l) => l.level === "error").map((l) => [l.msg, l.obj.problems])).toEqual([
      ["record failed its schema; finalized as needsReview", [{ path: "/fields/email/value", keyword: "maxLength", message: "too long" }]],
    ]);
  });
});

// SubmitChatInput (P4-T02) through the real command processor, planner on, against the throwaway test Postgres:
// valid; invalid ×3; duplicate; stale; another session's file; skip; plus the server-side checks the card can't make.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/pool.js";
import { listEvents } from "../../src/db/repos/events.js";
import { listFieldCandidates } from "../../src/db/repos/fieldCandidates.js";
import { getSession } from "../../src/db/repos/sessions.js";
import { listTimers } from "../../src/db/repos/timers.js";
import { CLOSED_SESSION_MESSAGE, WRONG_FIELD_MESSAGE } from "../../src/session/handlers/submitChatInput.js";
import { STALE_REQUEST_MESSAGE } from "../../src/session/handlers/chatInput.js";
import type { SessionServices } from "../../src/session/services.js";
import { answer, answerOpen, cards, openCard, PNG, sessionAtField, storeTestFile } from "../helpers/chatFlow.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { testServices } from "../helpers/session.js";

let schema: TestSchema;
let db: Database;
let services: SessionServices;

beforeAll(async () => {
  ({ schema, db } = await createMigratedSchema("submit"));
  services = testServices(db, { planner: true });
});
afterAll(async () => {
  await schema.drop();
});

const eventTypes = async (id: string, after = 0) => (await listEvents(db.pool, id, { afterSeq: after })).map((e) => e.type);
const lastSeq = async (id: string) => (await listEvents(db.pool, id)).at(-1)?.seq ?? 0;
const messages = async (id: string, after = 0) =>
  (await listEvents(db.pool, id, { afterSeq: after })).filter((e) => e.type === "chat.message").map((e) => (e.payload.message as { role: string; text: string }));

const sessionAt = (field: string) => sessionAtField(db, services, field);

describe("a valid answer", () => {
  it("is stored as a chat candidate, closes the card, shows the answer and an acknowledgement, and the next card opens", async () => {
    const id = await sessionAt("serialNumber");
    const before = await lastSeq(id);
    const reply = await answerOpen(db, services, id, "serialNumber", "35-209900-176148-1");
    expect(reply).toEqual({ status: "accepted" });
    expect(await eventTypes(id, before)).toEqual([
      "chat.message", // the user's answer
      "field.candidate",
      "input.answered",
      "chat.message", // "Thanks, I've got your IMEI."
      "chat.message", // the next card's lead-in (planner)
      "input.requested",
    ]);
    const said = await messages(id, before);
    expect(said.slice(0, 2)).toEqual([
      { id: expect.any(String), role: "user", text: "35-209900-176148-1", requestId: "req_serialNumber_1" },
      { id: expect.any(String), role: "agent", text: "Thanks, I've got your IMEI.", requestId: null },
    ]);
    const candidate = (await listFieldCandidates(db.pool, id, "serialNumber")).at(-1);
    expect(candidate).toMatchObject({ source: "chat", status: "valid", raw: "35-209900-176148-1", normalized: { kind: "imei", value: "352099001761481" } });
    expect((await cards(db, id)).find((c) => c.id === "req_serialNumber_1")?.status).toBe("answered");
    expect((await openCard(db, id))?.field).toBe("purchaseInvoice");
  });

  it("sent twice is acknowledged once: the repeat writes nothing (protocol.md §3.4)", async () => {
    const id = await sessionAt("email");
    await answerOpen(db, services, id, "email", "asha@example.com");
    const before = await getSession(db.pool, id);
    const seq = await lastSeq(id);
    expect(await answer(services, id, "req_email_1", "email", "asha@example.com")).toEqual({ status: "accepted" });
    expect(await lastSeq(id)).toBe(seq);
    expect(await getSession(db.pool, id)).toEqual(before);
  });

  it("is user activity: it arms the idle and session-expiry timers", async () => {
    const id = await sessionAt("deviceType");
    await answerOpen(db, services, id, "deviceType", "laptop");
    expect((await listTimers(db.pool, id)).map((t) => t.kind).sort()).toEqual(["idle", "sessionExpiry"]);
  });
});

describe("an invalid answer", () => {
  it("rejects with the validator's message and keeps the card open; the third cancels it, leaves the field invalid with attempts 3, and the planner moves on", async () => {
    const id = await sessionAt("serialNumber");
    const seen: string[][] = [];
    for (const bad of ["1234", "35-209900-176148-2", "AAAAAAAA"]) {
      const before = await lastSeq(id);
      expect(await answer(services, id, "req_serialNumber_1", "serialNumber", bad)).toEqual({ status: "rejected" });
      seen.push(await eventTypes(id, before));
    }
    expect(seen[0]).toEqual(["field.candidate", "input.rejected"]);
    expect(seen[1]).toEqual(["field.candidate", "input.rejected"]);
    expect(seen[2]).toEqual(["field.candidate", "input.cancelled", "chat.message", "chat.message", "input.requested"]);
    const events = await listEvents(db.pool, id);
    expect(events.filter((e) => e.type === "input.rejected").map((e) => e.payload)).toMatchObject([
      { requestId: "req_serialNumber_1", attempt: 1, message: "That IMEI has 4 digits; IMEIs have 15." },
      { requestId: "req_serialNumber_1", attempt: 2, message: "That IMEI's last digit doesn't match the others. Please check each digit." },
    ]);
    expect(events.find((e) => e.type === "input.cancelled")?.payload).toMatchObject({ requestId: "req_serialNumber_1", reason: "too many attempts", attempt: 3 });
    expect((await cards(db, id)).find((c) => c.id === "req_serialNumber_1")).toMatchObject({ status: "cancelled", attempts: 3 });
    expect((await listFieldCandidates(db.pool, id, "serialNumber")).map((c) => c.status)).toEqual(["invalid", "invalid", "invalid"]);
    expect((await openCard(db, id))?.field).toBe("purchaseInvoice");
    // Never asked again.
    expect((await cards(db, id)).filter((c) => c.field === "serialNumber")).toHaveLength(1);
  });

  it("a forged select value (not one of the server's options) is rejected", async () => {
    const id = await sessionAt("serviceCentre");
    expect(await answerOpen(db, services, id, "serviceCentre", "nyc-manhattan")).toEqual({ status: "rejected" });
    const urgencyId = await sessionAt("urgency");
    expect(await answerOpen(db, services, urgencyId, "urgency", "extremely")).toEqual({ status: "rejected" });
  });

  it("a required card can't be skipped (a null answer counts as an attempt)", async () => {
    const id = await sessionAt("email");
    expect(await answerOpen(db, services, id, "email", null)).toEqual({ status: "rejected" });
    expect((await openCard(db, id))?.attempts).toBe(1);
  });

  it("'don't know' for the model is re-asked once, then accepted as unknown (D14)", async () => {
    const id = await sessionAt("deviceModel");
    expect(await answerOpen(db, services, id, "deviceModel", "I don't know")).toEqual({ status: "rejected" });
    expect(await answerOpen(db, services, id, "deviceModel", "I don't know")).toEqual({ status: "accepted" });
    expect((await listFieldCandidates(db.pool, id, "deviceModel")).at(-1)?.normalized).toEqual({ brand: null, model: null });
  });
});

describe("stale and foreign answers", () => {
  it("a card that isn't open (unknown, cancelled) gets 'no longer active' and writes nothing", async () => {
    const id = await sessionAt("serialNumber");
    const seq = await lastSeq(id);
    // The reply names the card that is open, which the socket re-sends (P4 review #1).
    expect(await answer(services, id, "req_email_9", "email", "a@b.co")).toEqual({
      status: "stale",
      message: STALE_REQUEST_MESSAGE,
      open: { id: "req_serialNumber_1", field: "serialNumber", spec: expect.objectContaining({ label: "Serial number or IMEI" }) },
    });
    for (const bad of ["1", "2"]) await answer(services, id, "req_serialNumber_1", "serialNumber", bad);
    await answer(services, id, "req_serialNumber_1", "serialNumber", "3");
    const after = await lastSeq(id);
    expect(await answer(services, id, "req_serialNumber_1", "serialNumber", "35-209900-176148-1")).toEqual({
      status: "stale",
      message: STALE_REQUEST_MESSAGE,
      open: expect.objectContaining({ field: "purchaseInvoice" }),
    });
    expect(await lastSeq(id)).toBe(after);
    expect(after).toBeGreaterThan(seq);
  });

  it("an answer naming another card's field is refused without writing", async () => {
    const id = await sessionAt("email");
    const seq = await lastSeq(id);
    expect(await answer(services, id, "req_email_1", "serialNumber", "35-209900-176148-1")).toEqual({ status: "stale", message: WRONG_FIELD_MESSAGE });
    expect(await lastSeq(id)).toBe(seq);
  });

  it("another session's file id is rejected exactly like an unknown one", async () => {
    const id = await sessionAt("purchaseInvoice");
    const other = await sessionAt("deviceType");
    const theirs = await storeTestFile(db, other);
    expect(await answerOpen(db, services, id, "purchaseInvoice", `file:${theirs.id}`)).toEqual({ status: "rejected" });
    expect(await answerOpen(db, services, id, "purchaseInvoice", "file:fNoSuchFile000000")).toEqual({ status: "rejected" });
    const errors = (await listEvents(db.pool, id)).filter((e) => e.type === "input.rejected").map((e) => e.payload.message);
    expect(errors).toEqual(["That upload wasn't recognised. Please upload the file again.", "That upload wasn't recognised. Please upload the file again."]);
    const mine = await storeTestFile(db, id);
    expect(await answerOpen(db, services, id, "purchaseInvoice", `file:${mine.id}`)).toEqual({ status: "accepted" });
    expect((await listFieldCandidates(db.pool, id, "purchaseInvoice")).at(-1)?.normalized).toEqual({ fileId: mine.id, mime: "application/pdf", size: mine.size, sha256: mine.sha256 });
    const said = await messages(id);
    expect(said.find((m) => m.role === "user" && m.text === "invoice.pdf")).toBeDefined();
  });

  it("photos must be images; the answer bubble names the files", async () => {
    const id = await sessionAt("additionalPhotos");
    const pdf = await storeTestFile(db, id);
    expect(await answerOpen(db, services, id, "additionalPhotos", [`file:${pdf.id}`])).toEqual({ status: "rejected" });
    const photo = await storeTestFile(db, id, PNG, "image/png", "front.png");
    expect(await answerOpen(db, services, id, "additionalPhotos", [`file:${photo.id}`])).toEqual({ status: "accepted" });
    expect((await messages(id)).filter((m) => m.role === "user").at(-1)?.text).toBe("front.png");
  });

  it("a closed session takes no answers (a finalized one reopens: scenarios/outcomes.test.ts)", async () => {
    const id = await sessionAt("email");
    await db.pool.query("UPDATE sessions SET status = 'closed', outcome = 'partial' WHERE id = $1", [id]);
    expect(await answerOpen(db, services, id, "email", "asha@example.com")).toEqual({ status: "stale", message: CLOSED_SESSION_MESSAGE });
  });
});

describe("skipping an optional card", () => {
  it("stores a skipped candidate, says so, and the optional field isn't offered again", async () => {
    const id = await sessionAt("additionalPhotos");
    expect(await answerOpen(db, services, id, "additionalPhotos", null)).toEqual({ status: "accepted" });
    expect((await listFieldCandidates(db.pool, id, "additionalPhotos")).at(-1)).toMatchObject({ status: "skipped", normalized: null });
    const said = (await messages(id)).slice(-3);
    expect(said[0]).toMatchObject({ role: "user", text: "(skipped)" });
    expect(said[1]).toMatchObject({ role: "agent", text: "No problem, we'll skip that." });
    expect((await openCard(db, id))?.field).toBe("additionalNotes");
  });
});

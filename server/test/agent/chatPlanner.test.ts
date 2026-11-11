// The chat planner (P4-T01) as a pure function: one test per snapshot shape. The database-backed idempotency and
// crash-gap tests are in session/reconcile.test.ts.
import { CHAT_FIELDS, type RecordFieldId } from "@device-repair/shared/fields";
import { describe, expect, it } from "vitest";
import { chatMode, planChat, SAFETY_NET_MS } from "../../src/agent/chatPlanner.js";
import { STALLED_MESSAGE } from "../../src/agent/chatTemplates.js";
import type { Call } from "../../src/db/repos/calls.js";
import type { FieldCandidate } from "../../src/db/repos/fieldCandidates.js";
import type { StoredInputRequest } from "../../src/db/repos/inputRequests.js";
import type { JsonObject } from "../../src/db/repos/rows.js";
import type { Session } from "../../src/db/repos/sessions.js";
import { FIELDS, REQUIRED_RECORD_FIELDS } from "../../src/domain/fields.js";
import type { EventDraft } from "../../src/session/commands.js";
import type { Snapshot } from "../../src/session/snapshot.js";
import { VALID_VALUES } from "../domain/helpers.js";

const SID = "0b6f4c1e-3d2a-4e8b-9a71-5c2d8e9f1a3b";
const NOW = new Date("2026-11-10T06:00:00.000Z");
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

const session = (over: Partial<Session> = {}): Session => ({
  id: SID,
  status: "active",
  outcome: null,
  version: 3,
  currentRevision: 0,
  language: "en",
  activeCallId: null,
  openRequestId: null,
  reviewFlags: [],
  lastActivityAt: NOW,
  createdAt: at(-600),
  ...over,
});

const request = (id: string, field: string, status: StoredInputRequest["status"], over: Partial<StoredInputRequest> = {}): StoredInputRequest => {
  const createdAt = over.createdAt ?? at(-300);
  return {
    sessionId: SID,
    id,
    field,
    spec: ((FIELDS as Record<string, { card: object }>)[field]?.card ?? { kind: "confirm", label: "?" }) as JsonObject,
    status,
    attempts: 0,
    createdAt,
    updatedAt: createdAt,
    ...over,
  };
};

let candidateId = 0;
const candidate = (field: string, source: "call" | "chat", status: FieldCandidate["status"], collectedAt = at(-200), normalized: unknown = VALID_VALUES[field as RecordFieldId] ?? null): FieldCandidate => ({
  id: ++candidateId,
  sessionId: SID,
  eventSeq: candidateId,
  field,
  source: source as FieldCandidate["source"],
  raw: normalized as never,
  normalized: status === "valid" || status === "unverified" ? (normalized as never) : null,
  status,
  error: status === "invalid" ? "bad" : null,
  userConfirmed: false,
  collectedAt,
  evidence: null,
});

/** Valid candidates for these fields (call ones for voice fields, chat ones otherwise). */
const validFields = (fields: readonly RecordFieldId[], source?: "call" | "chat") =>
  fields.map((field) => candidate(field, source ?? (FIELDS[field].primaryChannel === "call" ? "call" : "chat"), "valid"));

const call = (over: Partial<Call> = {}): Call => ({ id: "c1", sessionId: SID, startedAt: at(-900), endedAt: at(-800), endReason: "user", ...over });

const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  session: session(),
  lastSeq: 10,
  history: { chatMessages: 0, chatStarted: false, chatStalled: false, lastReopenedSeq: 0 },
  timers: [],
  requests: [],
  candidates: [],
  calls: [],
  now: NOW,
  ...over,
});

/** A readable summary of the planned effects: [event type, the card or message it concerns]. */
const shape = (events: EventDraft[]) =>
  events.map((event) => [event.type, event.inputRequest?.id ?? event.inputRequestUpdate?.id ?? event.chatMessage?.text ?? (event.payload?.requestId as string | undefined) ?? null]);
const plan = (over: Partial<Snapshot>) => planChat(snapshot(over));

const chatStarted = { chatMessages: 1, chatStarted: true, chatStalled: false, lastReopenedSeq: 0 };
const ALL_REQUIRED = REQUIRED_RECORD_FIELDS;
const optionalDone = [request("req_additionalPhotos_1", "additionalPhotos", "answered"), request("req_additionalNotes_1", "additionalNotes", "answered")];

describe("mode", () => {
  it("is waiting before any call and before the noCallStart deadline, then chat; inCall during a call; closed once finalized", () => {
    expect(chatMode(snapshot())).toBe("waiting");
    expect(chatMode(snapshot({ history: chatStarted }))).toBe("chat");
    expect(chatMode(snapshot({ calls: [call()] }))).toBe("chat");
    expect(chatMode(snapshot({ session: session({ activeCallId: "c1" }), calls: [call({ endedAt: null })] }))).toBe("inCall");
    expect(chatMode(snapshot({ session: session({ status: "finalized", outcome: "completed" as never }) }))).toBe("closed");
    expect(chatMode(snapshot({ session: session({ status: "closed" }) }))).toBe("closed");
  });

  it("waiting and closed sessions get no card", () => {
    expect(plan({}).events).toEqual([]);
    expect(plan({ session: session({ status: "finalized" }), history: chatStarted }).events).toEqual([]);
  });
});

describe("chat mode: the next card", () => {
  it("a session that never had a call starts with the device, with a lead-in message, as req_<field>_1", () => {
    const { events } = plan({ history: chatStarted });
    expect(shape(events)).toEqual([
      ["chat.message", "Let's start with your device."],
      ["input.requested", "req_deviceType_1"],
    ]);
    expect(events[1]?.inputRequest).toMatchObject({ field: "deviceType", status: "open", spec: { kind: "select", label: "What kind of device is it?" } });
  });

  it("after a call, the chat fields come first and fields collected on the call are never asked again", () => {
    const candidates = validFields(["deviceType", "deviceModel"]);
    const { events } = plan({ calls: [call()], candidates });
    expect(shape(events)).toEqual([
      ["chat.message", "Thanks for the call. Let's finish the rest here in chat. Next, the device's serial number or IMEI, so we can look up its warranty."],
      ["input.requested", "req_serialNumber_1"],
    ]);
    // Everything but the two call fields asked, in order, as each is answered.
    const asked: string[] = [];
    let state = candidates;
    for (let i = 0; i < 12; i++) {
      const next = plan({ calls: [call()], candidates: state, requests: asked.map((f) => request(`req_${f}_1`, f, "answered")) }).events.find((e) => e.inputRequest);
      if (!next?.inputRequest || next.inputRequest.field === "submitConfirmation") break;
      asked.push(next.inputRequest.field);
      if (FIELDS[next.inputRequest.field as RecordFieldId].required) state = [...state, candidate(next.inputRequest.field, "chat", "valid")];
    }
    expect(asked).toEqual(["serialNumber", "purchaseInvoice", "serviceCentre", "email", "problemDescription", "problemStartedAt", "urgency", "additionalPhotos", "additionalNotes"]);
  });

  it("the after-call lead-in is only on the first card after the call", () => {
    const requests = [request("req_serialNumber_1", "serialNumber", "answered", { createdAt: at(-700) })];
    const { events } = plan({ calls: [call()], requests, candidates: [candidate("serialNumber", "chat", "valid")] });
    expect(shape(events)[0]).toEqual(["chat.message", "Please upload your purchase invoice."]);
  });

  it("an open card stays; nothing else opens (at most one open card)", () => {
    expect(plan({ history: chatStarted, requests: [request("req_deviceType_1", "deviceType", "open")] }).events).toEqual([]);
  });

  it("numbers a field's next card after its earlier ones", () => {
    const requests = [request("req_deviceType_1", "deviceType", "cancelled"), request("req_deviceType_2", "deviceType", "cancelled", { attempts: 1 })];
    expect(shape(plan({ history: chatStarted, requests }).events).at(-1)).toEqual(["input.requested", "req_deviceType_3"]);
  });

  it("optional fields are offered once: skipped or answered, they aren't asked again", () => {
    const candidates = [...validFields(ALL_REQUIRED), candidate("additionalPhotos", "chat", "skipped")];
    const requests = [request("req_additionalPhotos_1", "additionalPhotos", "answered")];
    expect(shape(plan({ history: chatStarted, candidates, requests }).events).at(-1)).toEqual(["input.requested", "req_additionalNotes_1"]);
  });

  it("all required valid and the optional fields offered → the summary and Submit claim?", () => {
    const { events } = plan({ history: chatStarted, candidates: validFields(ALL_REQUIRED), requests: optionalDone });
    expect(events.map((e) => e.type)).toEqual(["chat.message", "input.requested"]);
    expect(events[0]?.chatMessage?.text).toMatch(/^Here's your claim:\n• Device type: Phone\n• Device model: Apple iPhone 14 Pro\n/);
    expect(events[0]?.chatMessage?.text).toContain("• Serial number: IMEI 352099001761481");
    expect(events[0]?.chatMessage?.text).toContain("• Photos: none");
    expect(events[1]?.inputRequest).toMatchObject({ id: "req_submitConfirmation_1", field: "submitConfirmation", spec: { kind: "confirm", label: "Submit your claim?" } });
  });

  it("after No and an edit, Submit claim? is asked again as the next card", () => {
    const requests = [
      ...optionalDone,
      request("req_submitConfirmation_1", "submitConfirmation", "answered"),
      request("req_editField_1", "editField", "answered"),
      request("req_email_1", "email", "answered"),
      request("req_email_2", "email", "answered"),
    ];
    expect(shape(plan({ history: chatStarted, candidates: validFields(ALL_REQUIRED), requests }).events).at(-1)).toEqual(["input.requested", "req_submitConfirmation_2"]);
  });

  it("a field stuck after 3 invalid attempts isn't asked again; at the end the planner says once that it can't go further", () => {
    const others = ALL_REQUIRED.filter((f) => f !== "serialNumber");
    const requests = [...optionalDone, request("req_serialNumber_1", "serialNumber", "cancelled", { attempts: 3 })];
    const candidates = [...validFields(others), candidate("serialNumber", "chat", "invalid")];
    const first = plan({ history: chatStarted, candidates, requests });
    expect(shape(first.events)).toEqual([
      ["chat.stalled", null],
      ["chat.message", STALLED_MESSAGE],
    ]);
    expect(first.events[0]?.payload).toEqual({ fields: ["serialNumber"] });
    expect(plan({ history: { ...chatStarted, chatStalled: true }, candidates, requests }).events).toEqual([]);
  });

  it("a stuck field doesn't block the fields after it", () => {
    const requests = [request("req_deviceType_1", "deviceType", "cancelled", { attempts: 3 })];
    expect(shape(plan({ history: chatStarted, requests }).events).at(-1)).toEqual(["input.requested", "req_deviceModel_1"]);
  });
});

describe("cards made obsolete (P4-T01 step 3)", () => {
  it("a card whose field the call then provided is cancelled, and the next card opens", () => {
    const requests = [request("req_deviceType_1", "deviceType", "open", { createdAt: at(-100) })];
    const candidates = [candidate("deviceType", "call", "valid", at(-50))];
    expect(shape(plan({ history: chatStarted, requests, candidates }).events)).toEqual([
      ["input.cancelled", "req_deviceType_1"],
      ["chat.message", "Which model is it exactly?"],
      ["input.requested", "req_deviceModel_1"],
    ]);
  });

  it("a spoken email (unverified) never cancels the email card", () => {
    const requests = [request("req_email_1", "email", "open", { createdAt: at(-100) })];
    const candidates = [candidate("email", "call", "unverified", at(-50))];
    expect(plan({ calls: [call()], requests, candidates }).events).toEqual([]);
  });

  it("a card for a field that was already valid when the card was sent (the edit re-ask) stays open", () => {
    const requests = [request("req_deviceType_2", "deviceType", "open", { createdAt: at(-100) })];
    const candidates = [candidate("deviceType", "call", "valid", at(-500))];
    expect(plan({ calls: [call()], requests, candidates }).events).toEqual([]);
  });

  it("an invalid spoken value doesn't cancel anything", () => {
    const requests = [request("req_urgency_1", "urgency", "open", { createdAt: at(-100) })];
    expect(plan({ calls: [call()], requests, candidates: [candidate("urgency", "call", "invalid", at(-50))] }).events).toEqual([]);
  });
});

describe("queued cards", () => {
  it("a card the call agent queued opens when nothing is open, with a lead-in", () => {
    const requests = [request("req_email_1", "email", "queued")];
    expect(shape(plan({ session: session({ activeCallId: "c1" }), calls: [call({ endedAt: null })], requests }).events)).toEqual([
      ["chat.message", "I've sent you a box for your email address."],
      ["input.requested", "req_email_1"],
    ]);
  });

  it("a card the Stop flow paused comes back as input.resumed, without a lead-in", () => {
    const paused = request("req_email_1", "email", "queued", { createdAt: at(-300), updatedAt: at(-60) });
    const requests = [paused, request("req_optOutConfirmation_1", "optOutConfirmation", "answered")];
    expect(shape(plan({ history: chatStarted, requests }).events)).toEqual([["input.resumed", "req_email_1"]]);
  });

  it("a queued card waits while another is open", () => {
    const requests = [request("req_serialNumber_1", "serialNumber", "open"), request("req_email_1", "email", "queued")];
    expect(plan({ history: chatStarted, requests }).events).toEqual([]);
  });

  it("a queued card the call made obsolete is cancelled instead of opened", () => {
    const requests = [request("req_serviceCentre_1", "serviceCentre", "queued", { createdAt: at(-100) })];
    const candidates = [candidate("serviceCentre", "call", "valid", at(-50))];
    expect(shape(plan({ session: session({ activeCallId: "c1" }), calls: [call({ endedAt: null })], requests, candidates }).events)).toEqual([
      ["input.cancelled", "req_serviceCentre_1"],
    ]);
  });
});

describe("in-call safety net", () => {
  const inCall = (startedAgo: number, over: Partial<Snapshot> = {}) =>
    plan({ session: session({ activeCallId: "c1" }), calls: [call({ startedAt: at(-startedAgo / 1000), endedAt: null })], ...over });

  it("does nothing in the first 60 s of a call (the agent decides when to send cards)", () => {
    expect(inCall(SAFETY_NET_MS - 1000).events).toEqual([]);
  });

  it("sends the first chat card itself after 60 s if the agent hasn't sent any", () => {
    expect(shape(inCall(SAFETY_NET_MS).events)).toEqual([
      ["chat.message", `While we talk, you can fill this in here: ${FIELDS.serialNumber.card.label}`],
      ["input.requested", "req_serialNumber_1"],
    ]);
  });

  it("skips chat fields already valid, and does nothing once the agent has sent a card this call", () => {
    const candidates = [candidate("serialNumber", "chat", "valid")];
    expect(shape(inCall(SAFETY_NET_MS, { candidates }).events).at(-1)).toEqual(["input.requested", "req_purchaseInvoice_1"]);
    const requests = [request("req_email_1", "email", "answered", { createdAt: at(-10) })];
    expect(inCall(SAFETY_NET_MS * 2, { requests }).events).toEqual([]);
  });

  it("never opens voice fields or the confirmation during a call", () => {
    const candidates = validFields(CHAT_FIELDS);
    expect(inCall(SAFETY_NET_MS * 5, { candidates }).events).toEqual([]);
  });
});

describe("templates", () => {
  it("the summary stays under the 2,000-character message limit even with every value at its longest", async () => {
    const { summaryMessage } = await import("../../src/agent/chatTemplates.js");
    const { resolveFields } = await import("../../src/session/snapshot.js");
    const long = "x".repeat(1000);
    const values: Record<string, unknown> = {
      ...VALID_VALUES,
      deviceModel: { brand: long, model: long },
      problemDescription: { summary: long, verbatim: long },
      urgency: { level: "high", reason: long },
      serviceCentre: { id: "blr-koramangala", name: long, city: long },
      email: `${"a".repeat(64)}@${"b".repeat(180)}.com`,
      additionalNotes: long,
    };
    const fields = resolveFields(Object.keys(values).map((f) => candidate(f, "chat", "valid", at(-10), values[f])));
    const text = summaryMessage(fields);
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text.split("\n")).toHaveLength(12);
  });
});

describe("P4 review fixes", () => {
  it("#6 declining Stop brings back the paused card, not an older card the agent queued", () => {
    const agentQueued = request("req_email_1", "email", "queued", { createdAt: at(-300) });
    const paused = request("req_serialNumber_2", "serialNumber", "queued", { createdAt: at(-200), updatedAt: at(-60) });
    const requests = [agentQueued, paused, request("req_optOutConfirmation_1", "optOutConfirmation", "answered")];
    expect(shape(plan({ history: chatStarted, requests }).events)).toEqual([["input.resumed", "req_serialNumber_2"]]);
  });

  it("#5 a Submit claim? card the agent queued opens with the summary", () => {
    const requests = [...optionalDone, request("req_submitConfirmation_1", "submitConfirmation", "queued")];
    const { events } = plan({ session: session({ activeCallId: "c1" }), calls: [call({ endedAt: null })], candidates: validFields(ALL_REQUIRED), requests });
    expect(events.map((e) => e.type)).toEqual(["chat.message", "input.requested"]);
    expect(events[0]?.chatMessage?.text).toMatch(/^Here's your claim:/);
  });

  it("#2 the edit card leaves out narrative fields the call collected (a typed edit couldn't change them, D15)", async () => {
    const { editableFields } = await import("../../src/agent/chatTemplates.js");
    const { resolveFields } = await import("../../src/session/snapshot.js");
    const fromCall = resolveFields(validFields(ALL_REQUIRED));
    expect(editableFields(fromCall)).not.toEqual(expect.arrayContaining(["problemDescription"]));
    expect(editableFields(fromCall).filter((f) => ["problemDescription", "problemStartedAt", "urgency"].includes(f))).toEqual([]);
    expect(editableFields(fromCall)).toEqual(expect.arrayContaining(["deviceType", "deviceModel", "email", "additionalNotes"]));
    const typed = resolveFields(validFields(ALL_REQUIRED, "chat"));
    expect(editableFields(typed)).toHaveLength(11);
  });
});

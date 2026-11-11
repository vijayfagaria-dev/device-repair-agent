// Event → chat message projection (P3-T03) and the wire builders shared with replay: every message is a valid
// protocol message (zod, protocol.md §3.3) with the §1.1 id.
import { ChatServerMessageSchema } from "@device-repair/shared/protocol/schemas";
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../../src/db/repos/events.js";
import type { Session } from "../../src/db/repos/sessions.js";
import { FIELDS } from "../../src/domain/fields.js";
import {
  chatMessageWire,
  inputRequestWire,
  recordWire,
  sameSessionState,
  sessionStateWire,
  syncDoneWire,
  toChatMessages,
} from "../../src/ws/chatProjection.js";

const event = (type: string, payload: Record<string, unknown>): SessionEvent =>
  ({ sessionId: "s", seq: 3, type, channel: "chat", payload, createdAt: new Date(0) }) as SessionEvent;

describe("toChatMessages", () => {
  it("projects each chat-visible event type to its message", () => {
    const spec = FIELDS.email.card;
    const cases: [SessionEvent, unknown][] = [
      [event("chat.message", { message: { id: "abc123", role: "agent", text: "Hi", requestId: null } }), { type: "message", id: "m_abc123", role: "agent", text: "Hi" }],
      [
        event("chat.message", { message: { id: "u1", role: "user", text: "asha@example.com", requestId: "req_email_1" } }),
        { type: "message", id: "m_u1", role: "user", text: "asha@example.com", requestId: "req_email_1" },
      ],
      [event("transcript.final", { line: { id: "tu_c1_1", callId: "c1", role: "user", text: "hello", interrupted: false } }), { type: "transcript", id: "tu_c1_1", role: "user", text: "hello", final: true }],
      [
        event("input.requested", { request: { id: "req_email_1", field: "email", status: "open", attempts: 0, spec } }),
        { ...spec, type: "inputRequest", id: "req_email_1", field: "email" },
      ],
      [event("input.rejected", { requestId: "req_email_1", attempt: 2, message: "Bad" }), { type: "inputError", id: "err_req_email_1_2", requestId: "req_email_1", message: "Bad" }],
      [event("input.cancelled", { requestId: "req_email_1", reason: "already provided" }), { type: "inputCancel", id: "cancel_req_email_1", requestId: "req_email_1", reason: "already provided" }],
    ];
    for (const [input, expected] of cases) {
      const messages = toChatMessages(input);
      expect(messages, input.type).toEqual([expected]);
      for (const message of messages) expect(ChatServerMessageSchema.safeParse(message).success, input.type).toBe(true);
    }
  });

  it("projects session.finalized to the record message (rec_<revision>) only when the update carries that revision's record", () => {
    const finalized = event("session.finalized", { outcome: "partial", revision: 2, trigger: "idleTimeout" });
    const record = { revision: 2, payload: { revision: 2, outcome: "partial" } };
    const messages = toChatMessages(finalized, record);
    expect(messages).toEqual([{ type: "record", id: "rec_2", record: record.payload }]);
    for (const message of messages) expect(ChatServerMessageSchema.safeParse(message).success).toBe(true);
    expect(toChatMessages(finalized)).toEqual([]); // no record on the update (e.g. a replayed event): nothing to show
    expect(toChatMessages(finalized, { revision: 1, payload: {} })).toEqual([]); // another revision's record
  });

  it("projects nothing for events the chat doesn't show, or for malformed payloads", () => {
    for (const input of [
      event("session.created", { via: "chat" }),
      event("timer.fired", { kind: "idle" }),
      event("field.candidate", { candidate: {} }),
      event("chat.message", { message: "not an object" }),
      event("input.requested", { request: { id: "req_x_1", field: "x", status: "queued", spec: {} } }), // not open
      event("input.rejected", { requestId: "req_x_1" }), // no attempt number
    ]) {
      expect(toChatMessages(input), input.type).toEqual([]);
    }
  });
});

describe("wire builders", () => {
  it("never lets a stored spec override the request's own type, id or field", () => {
    const card = inputRequestWire({ id: "req_email_2", field: "email", spec: { type: "message", id: "evil", field: "x", kind: "email", label: "E" } });
    expect(card).toEqual({ type: "inputRequest", id: "req_email_2", field: "email", kind: "email", label: "E" });
  });

  it("sends a user message's requestId, but never an agent's", () => {
    expect(chatMessageWire({ id: "a", role: "agent", text: "t", requestId: "req_x_1" })).not.toHaveProperty("requestId");
    expect(chatMessageWire({ id: "a", role: "user", text: "t", requestId: "req_x_1" }).requestId).toBe("req_x_1");
  });

  it("builds sessionState, syncDone and record messages that match the protocol", () => {
    const session = { version: 42, status: "active", activeCallId: "c1", outcome: null, currentRevision: 0 } as unknown as Session;
    const state = sessionStateWire(session);
    expect(state).toEqual({ type: "sessionState", id: "state_42", status: "active", callActive: true, outcome: null, revision: null, voiceAvailable: true, notice: null });
    for (const message of [state, syncDoneWire(118), recordWire(2, { revision: 2 })]) expect(ChatServerMessageSchema.safeParse(message).success).toBe(true);
    expect(sameSessionState(state, sessionStateWire({ ...session, version: 43 }))).toBe(true);
    expect(sameSessionState(state, sessionStateWire({ ...session, version: 43, activeCallId: null }))).toBe(false);
  });
});

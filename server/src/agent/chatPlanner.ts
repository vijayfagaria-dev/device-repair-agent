// The chat planner (P4-T01, D13, architecture §6): an idempotent reconciler. `planChat` is pure: from a session
// snapshot it works out what the session's chat should look like (at most one open card, the right next card for the
// mode, obsolete cards cancelled) and returns the effects that get it there, or nothing when it is already there.
//
// It runs as the `Reconcile` command (session/handlers/requestInput.ts), under the session lock with a fresh snapshot,
// after every command, on every chat connect and for every active session at boot (D11). So nothing that must follow
// a commit depends on memory: a crash between "the call ended" and "the next card" is repaired by the next run.
//
// Modes:
// - waiting: no call yet and the noCallStart deadline hasn't passed (PD10): the user is expected to tap Call.
// - inCall: the call agent decides when to send chat cards (request_chat_input → queued requests, P5); the planner
//   opens them one at a time, plus a safety net: if the agent hasn't asked for any chat card within 60 s of the call,
//   the planner sends the first one itself, so chat collection isn't gated on the model.
// - chat: no call active, and a call has happened or the deadline passed: the planner runs the whole flow (P4-T04).
// - closed: the session is finalized or closed: nothing to do (reopening is P7-T05).
import { CALL_FIELDS, CHAT_FIELDS, OPTIONAL_FIELDS, type RecordFieldId } from "@device-repair/shared/fields";
import { Role } from "@device-repair/shared/protocol";
import type { StoredInputRequest } from "../db/repos/inputRequests.js";
import type { JsonObject } from "../db/repos/rows.js";
import type { ResolvedField } from "../domain/conflicts.js";
import { FIELDS, MAX_ATTEMPTS, REQUIRED_RECORD_FIELDS } from "../domain/fields.js";
import { missingRequired } from "../domain/outcome.js";
import type { EventDraft } from "../session/commands.js";
import { newMessageId } from "../session/ids.js";
import { resolveFields, type Snapshot } from "../session/snapshot.js";
import { agentCardLeadIn, type CardSpec, ControlField, leadIn, STALLED_MESSAGE, submitCard, summaryMessage } from "./chatTemplates.js";

export type ChatMode = "waiting" | "inCall" | "chat" | "closed";

/** If the call agent hasn't sent any chat card this long into a call, the planner sends the first one (P4-T01). */
export const SAFETY_NET_MS = 60_000;

/** Fields the chat may ask for: every record field has a card (voice fields have chat fallbacks, PD5). */
const RECORD_FIELDS = new Set<string>([...CALL_FIELDS, ...CHAT_FIELDS, ...OPTIONAL_FIELDS]);
export const isRecordField = (field: string): field is RecordFieldId => RECORD_FIELDS.has(field);

/** Order of the chat flow: a session that never had a call starts with the device; after a call, the chat fields first. */
const ORDER_NO_CALL: readonly RecordFieldId[] = [...CALL_FIELDS, ...CHAT_FIELDS, ...OPTIONAL_FIELDS];
const ORDER_AFTER_CALL: readonly RecordFieldId[] = [...CHAT_FIELDS, ...CALL_FIELDS, ...OPTIONAL_FIELDS];

export function chatMode(snapshot: Pick<Snapshot, "session" | "calls" | "history">): ChatMode {
  if (snapshot.session.status !== "active") return "closed";
  if (snapshot.session.activeCallId !== null) return "inCall";
  if (snapshot.calls.length > 0 || snapshot.history.chatStarted) return "chat";
  return "waiting";
}

const isPending = (request: StoredInputRequest) => request.status === "open" || request.status === "queued";

/** The next request id for a field: `req_<field>_<n>` (protocol.md §1.1), n counting this session's cards for it. */
export function nextRequestId(snapshot: Pick<Snapshot, "requests">, field: string): string {
  return `req_${field}_${snapshot.requests.filter((request) => request.field === field).length + 1}`;
}

/** The two drafts that open a new card: a short agent message, then the card itself. */
export function openCardDrafts(id: string, field: string, spec: CardSpec, message: string | null): EventDraft[] {
  const drafts: EventDraft[] = [];
  if (message) drafts.push({ type: "chat.message", channel: "chat", chatMessage: { id: newMessageId(), role: Role.AGENT, text: message } });
  drafts.push({ type: "input.requested", channel: "chat", inputRequest: { id, field, spec: { ...spec } as unknown as JsonObject, status: "open" } });
  return drafts;
}

export const cancelDraft = (requestId: string, reason: string): EventDraft => ({
  type: "input.cancelled",
  channel: "chat",
  payload: { requestId, reason },
  inputRequestUpdate: { id: requestId, status: "cancelled" },
});

/** What the planner knows about each field, derived from the snapshot. */
export interface FieldState {
  resolved: Readonly<Record<RecordFieldId, ResolvedField>>;
  /** The controller stopped asking: a card for the field was cancelled after MAX_ATTEMPTS invalid answers (D14). */
  stuck(field: RecordFieldId): boolean;
  /** The field still needs a card in the chat flow. */
  needs(field: RecordFieldId): boolean;
}

export function fieldState(snapshot: Pick<Snapshot, "requests" | "candidates">): FieldState {
  const resolved = resolveFields(snapshot.candidates);
  const cards = (field: string) => snapshot.requests.filter((request) => request.field === field);
  const stuck = (field: RecordFieldId) => cards(field).some((request) => request.status === "cancelled" && request.attempts >= MAX_ATTEMPTS);
  const needs = (field: RecordFieldId) => {
    if (cards(field).some(isPending)) return false;
    // Optional fields are offered once (PD4): answered, skipped or cancelled, they aren't asked again.
    if (!FIELDS[field].required) return cards(field).length === 0 && resolved[field].status === "missing";
    return resolved[field].status !== "valid" && !stuck(field);
  };
  return { resolved, stuck, needs };
}

/**
 * A card made obsolete by the call: its field received a valid spoken value after the card was sent (P4-T01 step 3).
 * Only an authoritative source cancels a card: a spoken email or serial number is `unverified` (chatOnly) and never
 * valid, so it never cancels its card. A field the user is re-entering from the edit card was valid before the card
 * was sent, so its card stays.
 */
function satisfiedByCall(snapshot: Pick<Snapshot, "candidates">, state: FieldState, request: StoredInputRequest): boolean {
  if (!isRecordField(request.field) || state.resolved[request.field].status !== "valid") return false;
  const since = request.createdAt.getTime();
  return snapshot.candidates.some(
    (candidate) => candidate.field === request.field && candidate.source === "call" && candidate.status === "valid" && candidate.collectedAt.getTime() >= since,
  );
}

export interface ChatPlan {
  mode: ChatMode;
  events: EventDraft[];
}

/** The planner: the effects that make the session's chat what it should be. Empty when it already is. */
export function planChat(snapshot: Snapshot): ChatPlan {
  const mode = chatMode(snapshot);
  const events: EventDraft[] = [];
  if (mode === "closed") return { mode, events };
  const state = fieldState(snapshot);
  const handled = new Set<string>();

  // 1. Cards the call made obsolete, open or queued.
  for (const request of snapshot.requests) {
    if (isPending(request) && satisfiedByCall(snapshot, state, request)) {
      events.push(cancelDraft(request.id, "already provided on the call"));
      handled.add(request.id);
    }
  }
  const pending = snapshot.requests.filter((request) => isPending(request) && !handled.has(request.id));

  // 2. At most one open card: an open one stays until it is answered or cancelled.
  if (pending.some((request) => request.status === "open")) return { mode, events };

  // 3. A queued card opens next: first a card the Stop flow paused (it was open before, so it was updated after it was
  //    created; it comes back without a new lead-in), then the call agent's, oldest first.
  const wasOpen = (request: StoredInputRequest) => request.updatedAt.getTime() > request.createdAt.getTime();
  const queuedCards = pending.filter((request) => request.status === "queued");
  const queued = queuedCards.filter(wasOpen).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0] ?? queuedCards[0];
  if (queued) {
    const resumed = wasOpen(queued);
    if (!resumed && isRecordField(queued.field)) {
      events.push({ type: "chat.message", channel: "chat", chatMessage: { id: newMessageId(), role: Role.AGENT, text: agentCardLeadIn(queued.field) } });
    } else if (!resumed && queued.field === ControlField.SUBMIT) {
      // The agent's "Submit claim?" comes with the summary, like the planner's (protocol.md §5; P4 review #5).
      events.push({ type: "chat.message", channel: "chat", chatMessage: { id: newMessageId(), role: Role.AGENT, text: summaryMessage(state.resolved) } });
    }
    events.push({ type: resumed ? "input.resumed" : "input.requested", channel: "chat", inputRequestUpdate: { id: queued.id, status: "open" } });
    return { mode, events };
  }

  if (mode === "waiting") return { mode, events };

  if (mode === "inCall") {
    const call = snapshot.calls.find((c) => c.id === snapshot.session.activeCallId) ?? snapshot.calls.findLast((c) => c.endedAt === null);
    if (!call || snapshot.now.getTime() - call.startedAt.getTime() < SAFETY_NET_MS) return { mode, events };
    const since = call.startedAt.getTime();
    const askedThisCall = snapshot.requests.some((request) => request.createdAt.getTime() >= since && isRecordField(request.field));
    const field = askedThisCall ? undefined : CHAT_FIELDS.find(state.needs);
    if (field) events.push(...openCardDrafts(nextRequestId(snapshot, field), field, FIELDS[field].card, leadIn(field, { inCall: true, afterCall: false })));
    return { mode, events };
  }

  // 4. Chat mode: the next field the flow needs, in order.
  const order = snapshot.calls.length > 0 ? ORDER_AFTER_CALL : ORDER_NO_CALL;
  const field = order.find(state.needs);
  if (field) {
    const lastEnd = Math.max(0, ...snapshot.calls.map((c) => c.endedAt?.getTime() ?? 0));
    const afterCall = snapshot.calls.length > 0 && !snapshot.requests.some((request) => request.createdAt.getTime() > lastEnd);
    events.push(...openCardDrafts(nextRequestId(snapshot, field), field, FIELDS[field].card, leadIn(field, { afterCall, inCall: false })));
    return { mode, events };
  }

  // 5. Nothing left to ask. Every required field valid → the summary and "Submit claim?" (PD2). Otherwise a required
  //    field couldn't be accepted (stuck after 3 attempts): the claim can't be confirmed (D16), so say so once; the
  //    idle timer then finalizes it for review (R-3, P7-T01).
  if (missingRequired(state.resolved).length === 0) {
    events.push(...openCardDrafts(nextRequestId(snapshot, ControlField.SUBMIT), ControlField.SUBMIT, submitCard(), summaryMessage(state.resolved)));
  } else if (!snapshot.history.chatStalled && REQUIRED_RECORD_FIELDS.some(state.stuck)) {
    events.push({ type: "chat.stalled", channel: "chat", payload: { fields: REQUIRED_RECORD_FIELDS.filter(state.stuck) } });
    events.push({ type: "chat.message", channel: "chat", chatMessage: { id: newMessageId(), role: Role.AGENT, text: STALLED_MESSAGE } });
  }
  return { mode, events };
}

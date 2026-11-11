// The call's commands (P5-T02, P5-T05/T06 tools): every state change a call makes goes through the processor, like
// chat's. StartCall/EndCall happen exactly once per call; the transcript keeps final lines only (D12); spoken values
// are validated by code, never trusted from the model (D13), and identifiers heard aloud are only `unverified`.
import type { RecordFieldId } from "@device-repair/shared/fields";
import { FieldSource, Role } from "@device-repair/shared/protocol";
import { nextRequestId, openCardDrafts } from "../../agent/chatPlanner.js";
import { callEndedMessage, ControlField, RESUME_PROMPT, resumeCard } from "../../agent/chatTemplates.js";
import type { JsonValue } from "../../db/repos/rows.js";
import { istToday } from "../../domain/dates.js";
import { FIELDS } from "../../domain/fields.js";
import type { ReviewFlag } from "../../domain/outcome.js";
import { validateEmail, validateSerialNumber, validateServiceCentre } from "../../domain/validators/chatFields.js";
import type { ValidationResult } from "../../domain/validators/result.js";
import { validateDeviceModel, validateDeviceType, validateProblemDescription, validateProblemStartedAt, validateUrgency } from "../../domain/validators/voiceFields.js";
import type { EventDraft, Handler } from "../commands.js";
import { newMessageId } from "../ids.js";
import { reopenedSnapshot, withReopen } from "./reopen.js";
import type { Snapshot } from "../snapshot.js";
import { type FinalizeDeps, finalizeEffects } from "./finalize.js";

/** Why a call ended (call.ended reason; protocol.md §6 close reasons map onto these). */
export type CallEndReason = "hangup" | "agent_ended" | "network" | "silence" | "max_duration" | "provider_error" | "server_restart" | "opted_out";

export interface StartCall {
  type: "StartCall";
  callId: string;
}
export type StartCallReply = { status: "started"; returning: boolean } | { status: "refused"; reason: "active" | "closed" | "resumeRequired" };

/**
 * A new call is explicit user activity (D16): on a finalized session it reopens it (P7-T05). After an opt-out the call
 * is refused and the chat gets "Resume your claim?" first; the user calls again once they said Yes.
 */
export const startCallHandler: Handler<StartCall, StartCallReply> = (snapshot, command) => {
  if (snapshot.session.status === "finalized") {
    const reopened = reopenedSnapshot(snapshot, "callStarted");
    if (reopened) return withReopen(snapshot, "callStarted", startActiveCall(reopened, command));
    if (snapshot.session.outcome === "optedOut") {
      const pending = snapshot.requests.some((r) => r.field === ControlField.RESUME && (r.status === "open" || r.status === "queued"));
      const events = pending ? [] : openCardDrafts(nextRequestId(snapshot, ControlField.RESUME), ControlField.RESUME, resumeCard(), RESUME_PROMPT);
      return { events, reply: { status: "refused", reason: "resumeRequired" } };
    }
  }
  return startActiveCall(snapshot, command);
};

const startActiveCall: Handler<StartCall, StartCallReply> = (snapshot, { callId }) => {
  if (snapshot.session.status !== "active") return { reply: { status: "refused", reason: "closed" } };
  if (snapshot.session.activeCallId !== null) return { reply: { status: "refused", reason: "active" } };
  const returning = snapshot.calls.length > 0;
  return {
    call: { start: { id: callId, startedAt: snapshot.now } },
    session: { activeCallId: callId },
    events: [{ type: "call.started", channel: "call", payload: { callId, returning } }],
    timers: { clear: ["noCallStart"] },
    activity: true, // a new call is explicit user activity (D16)
    reply: { status: "started", returning },
  };
};

export interface EndCall {
  type: "EndCall";
  callId: string;
  reason: CallEndReason;
}
export type EndCallReply = { status: "ended"; seconds: number } | { status: "notActive" };

export const endCallHandler: Handler<EndCall, EndCallReply> = (snapshot, { callId, reason }) => {
  // Exactly once: only the call that is active ends it; a second end (another close path) is a no-op.
  if (snapshot.session.activeCallId !== callId) return { reply: { status: "notActive" } };
  const call = snapshot.calls.find((c) => c.id === callId);
  const seconds = call ? Math.max(0, Math.round((snapshot.now.getTime() - call.startedAt.getTime()) / 1000)) : 0;
  const events: EventDraft[] = [{ type: "call.ended", channel: "call", payload: { callId, reason, seconds } }];
  // A reason-specific note for ends the user didn't choose (P5-T09); after an ordinary hang-up the planner's
  // "Thanks for the call…" lead-in says it with the next card.
  const note = callEndedMessage(reason);
  if (note) events.push({ type: "chat.message", channel: "chat", chatMessage: { id: newMessageId(), role: Role.AGENT, text: note } });
  return { call: { end: { id: callId, reason, endedAt: snapshot.now } }, session: { activeCallId: null }, events, reply: { status: "ended", seconds } };
};

export interface AppendTranscript {
  type: "AppendTranscript";
  line: { id: string; callId: string; role: Role; text: string; interrupted?: boolean; startedAt: Date };
}

export const appendTranscriptHandler: Handler<AppendTranscript, { appended: boolean }> = (snapshot, { line }) => {
  if (!snapshot.calls.some((c) => c.id === line.callId) || !line.text.trim()) return { reply: { appended: false } };
  return { events: [{ type: "transcript.final", channel: "call", transcriptLine: line }], reply: { appended: true } };
};

export interface SaveSpokenField {
  type: "SaveSpokenField";
  field: string;
  value: string;
  evidence: string;
  userConfirmed?: boolean;
}
export type SaveSpokenFieldReply =
  | { status: "valid" | "unverified"; normalized: unknown }
  | { status: "invalid"; error: string }
  | { status: "refused"; reason: "notSpoken" | "notActive" };

/** Validates what was heard for a field (D14), from the model's value and the customer's words. */
export function validateSpoken(snapshot: Pick<Snapshot, "candidates" | "now">, field: RecordFieldId, value: string, evidence: string): ValidationResult<unknown> {
  switch (field) {
    case "deviceType":
      return validateDeviceType(value);
    case "deviceModel": {
      // "Don't know" is asked again once, then accepted as unknown (D14).
      const triedBefore = snapshot.candidates.some((c) => c.field === "deviceModel" && c.source === "call" && c.status === "invalid");
      return validateDeviceModel(value, { allowUnknown: triedBefore });
    }
    case "problemDescription":
      return validateProblemDescription({ summary: value, verbatim: evidence || value });
    case "problemStartedAt":
      // The customer's words decide (relative dates are resolved in code, P0-T03), the model's value only if none.
      return validateProblemStartedAt(evidence.trim() ? { spoken: evidence, date: value } : value, { today: istToday(snapshot.now) });
    case "urgency":
      return validateUrgency({ level: value, reason: evidence });
    case "serviceCentre":
      return validateServiceCentre(value, { spoken: true });
    case "serialNumber":
      return validateSerialNumber(value);
    case "email":
      return validateEmail(value);
    default:
      return { status: "invalid", error: "That needs the chat card." };
  }
}

export const saveSpokenFieldHandler: Handler<SaveSpokenField, SaveSpokenFieldReply> = (snapshot, command) => {
  if (snapshot.session.status !== "active") return { reply: { status: "refused", reason: "notActive" } };
  const field = command.field as RecordFieldId;
  if (!Object.hasOwn(FIELDS, field) || !FIELDS[field].spokenCapture) return { reply: { status: "refused", reason: "notSpoken" } };
  const result = validateSpoken(snapshot, field, command.value, command.evidence);
  // An identifier heard aloud is noted but never accepted: it must be typed (D13).
  const chatOnly = FIELDS[field].authority === "chatOnly";
  const status = result.status === "valid" ? (chatOnly ? "unverified" : "valid") : "invalid";
  const normalized = result.status === "valid" ? result.normalized : null;
  const error = result.status === "invalid" ? result.error : null;
  return {
    events: [
      {
        type: "field.candidate",
        channel: "call",
        candidate: {
          field,
          source: FieldSource.CALL,
          // The model's value only: its quote of the transcript (evidence) stays in the candidate row, out of the
          // event payload and so out of the timeline (D12, commands.ts).
          raw: command.value as JsonValue,
          normalized: normalized as JsonValue | null,
          status,
          error,
          userConfirmed: command.userConfirmed === true,
          evidence: command.evidence,
        },
      },
    ],
    activity: true,
    reply: status === "invalid" ? { status, error: error ?? "That didn't sound right." } : { status, normalized },
  };
};

export interface FlagForReview {
  type: "FlagForReview";
  kind: "safety" | "other";
  reason: string;
}

export const flagForReviewHandler: Handler<FlagForReview, { status: "flagged" | "alreadyFlagged" | "notActive" }> = (snapshot, { kind, reason }) => {
  if (snapshot.session.status !== "active") return { reply: { status: "notActive" } };
  const flag: ReviewFlag = { rule: kind === "safety" ? "R-1" : "R-5", reason: reason.slice(0, 300) };
  const existing = snapshot.session.reviewFlags as { rule?: string; reason?: string }[];
  if (existing.some((f) => f.rule === flag.rule && f.reason === flag.reason)) return { reply: { status: "alreadyFlagged" } };
  return {
    session: { reviewFlags: [...snapshot.session.reviewFlags, { rule: flag.rule, reason: flag.reason }] },
    events: [{ type: "review.flagged", channel: "call", payload: { rule: flag.rule, reason: flag.reason } }],
    reply: { status: "flagged" },
  };
};

export interface OptOutByCall {
  type: "OptOutByCall";
}

export const optOutByCallHandler =
  (deps: FinalizeDeps): Handler<OptOutByCall, { status: "optedOut"; revision: number } | { status: "refused"; reason: string }> =>
  (snapshot) => {
    const result = finalizeEffects(snapshot, { trigger: "optOutConfirmed", submitConfirmedAt: null }, deps);
    if (!result.finalized) return { reply: { status: "refused", reason: result.reason } };
    const { events, ...effects } = result.effects;
    return { ...effects, events: [{ type: "optout.confirmed", channel: "call" }, ...events], reply: { status: "optedOut", revision: result.revision } };
  };

export interface AgentSays {
  type: "AgentSays";
  text: string;
}

/** An agent line in the chat (the failure matrix: the voice failed, so the words go to the chat instead). */
export const agentSaysHandler: Handler<AgentSays, { said: boolean }> = (_snapshot, { text }) => {
  const clean = text.trim().slice(0, 2000);
  if (!clean) return { reply: { said: false } };
  return { events: [{ type: "chat.message", channel: "chat", chatMessage: { id: newMessageId(), role: Role.AGENT, text: clean } }], reply: { said: true } };
};

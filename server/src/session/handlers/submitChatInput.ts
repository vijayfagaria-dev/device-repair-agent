// SubmitChatInput (P4-T02): the user's answer to a chat card.
//
// The request must be the session's open card and the field must match; the value is validated on the server (the
// client's card is only a hint) → a candidate is appended (valid, invalid or skipped) → accepted (the user's answer
// and an agent acknowledgement as chat messages) or rejected (inputError, the card stays open); the third invalid
// answer cancels the card, the field stays invalid with attempts = 3 (D14) and the planner moves on.
// - An answer to a card already answered is the same result again: nothing is written (a double send).
// - A card that isn't open (cancelled, never sent, another session's): "This request is no longer active."
// - `file:` refs must name uploads of this session.
// - A closed session takes no answers. A finalized session reopens when the answer is to a card it kept open (a
//   `partial` session's, P7-T05); an opted-out one only through "Resume your claim?".
// Control cards (protocol.md §5): Yes on "Submit claim?" finalizes in this same command (confirmSubmit); No opens the
// "What would you like to change?" card, whose answer re-asks that field. Yes on "Stop your claim?" finalizes as
// optedOut; No lets the planner bring back the card the Stop flow paused.
import type { RecordFieldId } from "@device-repair/shared/fields";
import { FieldSource, Role } from "@device-repair/shared/protocol";
import { cancelDraft, isRecordField, nextRequestId, openCardDrafts } from "../../agent/chatPlanner.js";
import {
  acknowledgement,
  answerText,
  type CardSpec,
  ControlField,
  EDIT_LEAD_IN,
  editCard,
  RESUME_ACCEPTED_MESSAGE,
  RESUME_DECLINED_MESSAGE,
  RESUME_MESSAGE,
  STILL_MISSING_MESSAGE,
  tooManyAttempts,
} from "../../agent/chatTemplates.js";
import { listFiles } from "../../db/repos/files.js";
import type { StoredInputRequest } from "../../db/repos/inputRequests.js";
import type { JsonValue } from "../../db/repos/rows.js";
import { istToday } from "../../domain/dates.js";
import { FIELDS, MAX_ATTEMPTS } from "../../domain/fields.js";
import { validateAdditionalNotes, validateEmail, validateSerialNumber, validateServiceCentre, validateSubmitConfirmation } from "../../domain/validators/chatFields.js";
import { validateFileSelection } from "../../domain/validators/files.js";
import { invalid, type ValidationResult, valid } from "../../domain/validators/result.js";
import { validateDeviceModel, validateDeviceType, validateProblemDescription, validateProblemStartedAt, validateUrgency } from "../../domain/validators/voiceFields.js";
import type { Effects, EventDraft, Handler, Prepare } from "../commands.js";
import { newMessageId } from "../ids.js";
import { resolveFields, type Snapshot } from "../snapshot.js";
import { type OpenCardRef, STALE_REQUEST_MESSAGE, type SubmitChatInput, type SubmitChatInputReply } from "./chatInput.js";
import { type FinalizeDeps, finalizeEffects, finalizeExtras } from "./finalize.js";
import { reopenedSnapshot, withReopen } from "./reopen.js";

export const CLOSED_SESSION_MESSAGE = "This claim has already been submitted, so it can't be changed here.";
export const WRONG_FIELD_MESSAGE = "This answer doesn't match the question. Please try again.";

const FILE_FIELDS = new Set<string>(["purchaseInvoice", "additionalPhotos"]);
const IMAGE = /^image\//;

const agentSays = (text: string): EventDraft => ({ type: "chat.message", channel: "chat", chatMessage: { id: newMessageId(), role: Role.AGENT, text } });

/** A select card's value must be one of the options the server sent (D14: the client list is never trusted). */
function chosen(spec: CardSpec, value: unknown): string | null {
  return typeof value === "string" && (spec.options ?? []).some((option) => option.value === value) ? value : null;
}

interface CheckedAnswer {
  result: ValidationResult<unknown>;
  /** Display names of the files answered (for the answer bubble). */
  fileNames: string[];
}

/** Validates an answer to a record field's card (D14). Never trusts the card: options and files are re-checked. */
function checkFieldAnswer(snapshot: Snapshot, request: StoredInputRequest, field: RecordFieldId, value: unknown): CheckedAnswer {
  const spec = request.spec as unknown as CardSpec;
  const none = (result: ValidationResult<unknown>): CheckedAnswer => ({ result, fileNames: [] });
  switch (field) {
    case "deviceType": {
      const option = chosen(spec, value);
      return none(option ? validateDeviceType(option) : invalid("Please choose one of the options."));
    }
    case "urgency": {
      const option = chosen(spec, value);
      return none(option ? validateUrgency(option) : invalid("Please choose one of the options."));
    }
    case "deviceModel":
      // "Don't know" is re-asked once, then accepted as unknown (D14).
      return none(validateDeviceModel(value, { allowUnknown: request.attempts >= 1 }));
    case "problemDescription":
      return none(validateProblemDescription(value));
    case "problemStartedAt":
      return none(typeof value === "string" ? validateProblemStartedAt(value, { today: istToday(snapshot.now) }) : invalid("Please choose a valid date."));
    case "serialNumber":
      return none(validateSerialNumber(value));
    case "serviceCentre":
      return none(validateServiceCentre(value));
    case "email":
      return none(validateEmail(value));
    case "additionalNotes":
      return none(validateAdditionalNotes(value));
    case "purchaseInvoice":
    case "additionalPhotos": {
      const selection = validateFileSelection(field, value);
      if (selection.status !== "valid") return none(selection);
      const owned = new Map((snapshot.files ?? []).map((file) => [file.id, file]));
      const files = selection.normalized.map((id) => owned.get(id));
      // Another session's file id looks exactly like an unknown one: nothing about it is revealed.
      if (files.some((file) => file === undefined)) return none(invalid("That upload wasn't recognised. Please upload the file again."));
      const stored = files as NonNullable<(typeof files)[number]>[];
      if (field === "additionalPhotos" && stored.some((file) => !IMAGE.test(file.mime))) return none(invalid("Photos must be JPEG, PNG or WebP images."));
      const descriptors = stored.map((file) => ({ fileId: file.id, mime: file.mime, size: file.size, sha256: file.sha256 }));
      return { result: valid(field === "purchaseInvoice" ? descriptors[0] : descriptors), fileNames: stored.map((file) => file.originalName ?? "file") };
    }
  }
}

/** The drafts every answered card starts with: the user's answer in the thread, the candidate, the card closed. */
function answeredDrafts(request: StoredInputRequest, text: string, candidate: NonNullable<EventDraft["candidate"]>): EventDraft[] {
  return [
    { type: "chat.message", channel: "chat", chatMessage: { id: newMessageId(), role: Role.USER, text, requestId: request.id } },
    { type: "field.candidate", channel: "chat", candidate },
    { type: "input.answered", channel: "chat", payload: { requestId: request.id }, inputRequestUpdate: { id: request.id, status: "answered" } },
  ];
}

/** An invalid answer: one more attempt; the third cancels the card (D14). */
function rejected(request: StoredInputRequest, field: string, value: unknown, error: string): Effects<SubmitChatInputReply> {
  const attempt = request.attempts + 1;
  const candidate: EventDraft = {
    type: "field.candidate",
    channel: "chat",
    candidate: { field, source: FieldSource.CHAT, raw: value as JsonValue, status: "invalid", error },
  };
  if (attempt < MAX_ATTEMPTS) {
    return {
      events: [
        candidate,
        {
          type: "input.rejected",
          channel: "chat",
          payload: { requestId: request.id, attempt, message: error },
          inputRequestUpdate: { id: request.id, status: "open", attempts: attempt },
        },
      ],
      activity: true,
      reply: { status: "rejected" },
    };
  }
  const events: EventDraft[] = [
    candidate,
    {
      type: "input.cancelled",
      channel: "chat",
      payload: { requestId: request.id, reason: "too many attempts", attempt },
      inputRequestUpdate: { id: request.id, status: "cancelled", attempts: attempt },
    },
  ];
  if (isRecordField(field)) events.push(agentSays(tooManyAttempts(field)));
  return { events, activity: true, reply: { status: "rejected" } };
}

const chatCandidate = (field: string, value: unknown, status: "valid" | "skipped", normalized: unknown) => ({
  field,
  source: FieldSource.CHAT,
  raw: value as JsonValue,
  normalized: (status === "valid" ? normalized : null) as JsonValue | null,
  status,
});

/** The session's open card, unless it is `except` (the one being answered). */
export function openCardRef(snapshot: Pick<Snapshot, "requests">, except?: string): OpenCardRef | undefined {
  const open = snapshot.requests.find((candidate) => candidate.status === "open");
  return open && open.id !== except ? { id: open.id, field: open.field, spec: open.spec } : undefined;
}

export const submitChatInputHandler =
  (deps: FinalizeDeps): Handler<SubmitChatInput, SubmitChatInputReply> =>
  (snapshot, command) => {
    const request = snapshot.requests.find((candidate) => candidate.id === command.requestId);
    if (snapshot.session.status === "finalized" && request?.status === "open") {
      if (request.field === ControlField.RESUME) return resumeAnswer(snapshot, request, command.value);
      // The card a `partial` session kept open: answering it is the user coming back (P7-T05).
      const reopened = reopenedSnapshot(snapshot, "chatInput");
      if (reopened) return withReopen(snapshot, "chatInput", answerCard(deps)(reopened, command));
    }
    return answerCard(deps)(snapshot, command);
  };

/** "Resume your claim?" after an opt-out: Yes reopens (and the planner carries on); No leaves the session as it is. */
function resumeAnswer(snapshot: Snapshot, request: StoredInputRequest, value: unknown): Effects<SubmitChatInputReply> {
  const answer = validateSubmitConfirmation(value);
  if (answer.status !== "valid") return rejected(request, request.field, value, answer.status === "invalid" ? answer.error : "Please tap Yes or No.");
  const spec = request.spec as unknown as CardSpec;
  const yes = answer.normalized === true;
  const events = [
    ...answeredDrafts(request, answerText(spec, value), chatCandidate(request.field, value, "valid", answer.normalized)),
    agentSays(yes ? RESUME_ACCEPTED_MESSAGE : RESUME_DECLINED_MESSAGE),
  ];
  if (!yes) return { events, reply: { status: "accepted" } }; // still opted out: no reopen, no new revision, no activity
  const reopened = reopenedSnapshot(snapshot, "resumeConfirmed");
  if (!reopened) return { events, reply: { status: "accepted" } };
  return withReopen(snapshot, "resumeConfirmed", { events, activity: true, reply: { status: "accepted" } });
}

const answerCard =
  (deps: FinalizeDeps): Handler<SubmitChatInput, SubmitChatInputReply> =>
  (snapshot, command) => {
    const stale = (message: string): Effects<SubmitChatInputReply> => {
      const open = openCardRef(snapshot, command.requestId);
      return { reply: open ? { status: "stale", message, open } : { status: "stale", message } };
    };
    const request = snapshot.requests.find((candidate) => candidate.id === command.requestId);
    if (!request) return stale(STALE_REQUEST_MESSAGE);
    // A repeat of an answered card: the same result, nothing new (protocol.md §3.4).
    if (request.status === "answered") return { reply: { status: "accepted" } };
    if (snapshot.session.status !== "active") return stale(CLOSED_SESSION_MESSAGE);
    if (request.status !== "open") return stale(STALE_REQUEST_MESSAGE);
    if (command.field !== request.field) return stale(WRONG_FIELD_MESSAGE);

    const spec = request.spec as unknown as CardSpec;
    const { value } = command;

    if (isRecordField(request.field)) {
      const field = request.field;
      const { result, fileNames } = checkFieldAnswer(snapshot, request, field, value);
      if (result.status === "invalid") return rejected(request, field, value, result.error);
      // A null answer is a skip, but only an optional card offers Skip.
      if (result.status === "skipped" && FIELDS[field].required) return rejected(request, field, value, "Please answer this one; it can't be skipped.");
      const normalized = result.status === "valid" ? result.normalized : null;
      return {
        events: [
          ...answeredDrafts(request, answerText(spec, value, fileNames), chatCandidate(field, value, result.status, normalized)),
          agentSays(acknowledgement(field, normalized, result.status === "skipped")),
        ],
        activity: true,
        reply: { status: "accepted" },
      };
    }

    switch (request.field) {
      case ControlField.SUBMIT:
      case ControlField.OPT_OUT: {
        const answer = validateSubmitConfirmation(value);
        if (answer.status !== "valid") return rejected(request, request.field, value, answer.status === "invalid" ? answer.error : "Please tap Yes or No.");
        const drafts = answeredDrafts(request, answerText(spec, value), chatCandidate(request.field, value, "valid", answer.normalized));
        const optOut = request.field === ControlField.OPT_OUT;
        if (optOut) drafts.push({ type: answer.normalized ? "optout.confirmed" : "optout.declined", channel: "chat" });
        if (!answer.normalized) {
          // No to "Submit claim?": what to change. No to "Stop?": the planner brings back the paused card.
          if (optOut) return { events: [...drafts, agentSays(RESUME_MESSAGE)], activity: true, reply: { status: "accepted" } };
          return {
            events: [...drafts, ...openCardDrafts(nextRequestId(snapshot, ControlField.EDIT), ControlField.EDIT, editCard(resolveFields(snapshot.candidates)), null)],
            activity: true,
            reply: { status: "accepted" },
          };
        }
        const result = finalizeEffects(
          snapshot,
          {
            trigger: optOut ? "optOutConfirmed" : "confirmSubmit",
            submitConfirmedAt: optOut ? null : snapshot.now,
            pending: { chatMessages: 1, chatAnswers: 1 },
            handled: new Set([request.id]),
          },
          deps,
        );
        if (!result.finalized) {
          // Not finalizable (a required field is no longer valid): say so; the planner asks for what's missing.
          return { events: [...drafts, agentSays(STILL_MISSING_MESSAGE)], activity: true, reply: { status: "accepted" } };
        }
        const { events, ...effects } = result.effects;
        return {
          ...effects,
          events: [...drafts, ...events],
          activity: true,
          reply: { status: "accepted", finalized: { revision: result.revision, outcome: result.outcome, ...(result.schemaProblems ? { schemaProblems: result.schemaProblems } : {}) } },
        };
      }
      case ControlField.EDIT: {
        const option = chosen(spec, value);
        if (!option || !isRecordField(option)) return rejected(request, request.field, value, "Please choose one of the options.");
        const events = answeredDrafts(request, answerText(spec, value), chatCandidate(request.field, value, "valid", option));
        // One card per field: a card still queued for it (the call agent's) gives way to the re-ask.
        for (const other of snapshot.requests) {
          if (other.field === option && other.status === "queued") events.push(cancelDraft(other.id, "replaced"));
        }
        events.push(...openCardDrafts(nextRequestId(snapshot, option), option, FIELDS[option].card, EDIT_LEAD_IN(option)));
        return { events, activity: true, reply: { status: "accepted" } };
      }
      default:
        // A control card this server doesn't handle (conflictChoice, P5), or "Resume your claim?" on an active session.
        return stale(STALE_REQUEST_MESSAGE);
    }
  };

/**
 * Reads the answer needs beyond the snapshot: this session's uploads for a file card, and the session's cost when a
 * Yes on a confirm card will finalize.
 */
export const submitChatInputPrepare: Prepare<SubmitChatInput> = async (tx, snapshot, command) => {
  const request = snapshot.requests.find((candidate) => candidate.id === command.requestId);
  // A finalized session is read too: a partial one reopens and may finalize again in this command (P7-T05).
  if (request?.status !== "open" || snapshot.session.status === "closed") return {};
  if (FILE_FIELDS.has(request.field)) return { files: await listFiles(tx, snapshot.session.id) };
  if ((request.field === ControlField.SUBMIT || request.field === ControlField.OPT_OUT) && command.value === true) {
    return finalizeExtras(tx, snapshot.session.id);
  }
  return {};
};

// Every sentence the chat side writes (P4-T04): the planner's lead-ins, acknowledgements, the summary, the control
// cards and the closing messages. One file, so the tone stays consistent and is easy to tune. Pure; every string is
// short plain text well under the 2,000-character limit for an outbound message (protocol.md §7).
import { RECORD_FIELD_IDS, type RecordFieldId } from "@device-repair/shared/fields";
import { type InputRequest, InputKind, Outcome } from "@device-repair/shared/protocol";
import type { ResolvedField } from "../domain/conflicts.js";
import { FIELDS } from "../domain/fields.js";
import { cleanText, truncate } from "../domain/validators/strings.js";

/** A card as stored in `input_requests.spec`: the wire `inputRequest` without its per-request parts. */
export type CardSpec = Omit<InputRequest, "type" | "id" | "field">;

/** The control fields of protocol.md §5 that P4 uses. */
export const ControlField = {
  SUBMIT: "submitConfirmation",
  EDIT: "editField",
  OPT_OUT: "optOutConfirmation",
  RESUME: "resumeConfirmation",
} as const;
export type ControlFieldId = (typeof ControlField)[keyof typeof ControlField];

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
export const fieldName = (field: RecordFieldId): string => capitalize(FIELDS[field].label);

// ---------------------------------------------------------------------------------------------------------------------
// Control cards (protocol.md §5)

export const submitCard = (): CardSpec => ({ ...FIELDS.submitConfirmation.card });

/**
 * "What would you like to change?": the record fields a typed answer can change. A narrative field the call collected
 * (problem, start date, urgency) is left out: the spoken account wins over a typed one (D15), so editing it in chat
 * couldn't change the record (P4 review #2; changing that policy is an owner decision).
 */
export const editableFields = (fields: Readonly<Record<RecordFieldId, ResolvedField>>): RecordFieldId[] =>
  RECORD_FIELD_IDS.filter((id) => !(FIELDS[id].conflictClass === "narrative" && fields[id].source === "call"));

export const editCard = (fields: Readonly<Record<RecordFieldId, ResolvedField>>): CardSpec => ({
  kind: InputKind.SELECT,
  label: "What would you like to change?",
  required: true,
  options: editableFields(fields).map((id) => ({ value: id, label: fieldName(id) })),
});

export const optOutCard = (): CardSpec => ({
  kind: InputKind.CONFIRM,
  label: "Stop your claim?",
  help: "What you've shared so far will be kept.",
  required: true,
});

/** "Resume your claim?": what a user who opted out sees when they come back (P7-T05, protocol.md §5). */
export const resumeCard = (): CardSpec => ({
  kind: InputKind.CONFIRM,
  label: "Resume your claim?",
  help: "What you shared before is still saved.",
  required: true,
});
export const RESUME_PROMPT = "Welcome back. You stopped this claim earlier. Would you like to pick it up again?";
export const RESUME_ACCEPTED_MESSAGE = "Welcome back. Let's carry on.";
export const RESUME_DECLINED_MESSAGE = "OK, your claim stays stopped.";

// ---------------------------------------------------------------------------------------------------------------------
// Lead-ins: one short message with each new card the planner opens (P4-T01 step 4)

const LEAD_INS: Record<RecordFieldId, string> = {
  deviceType: "Let's start with your device.",
  deviceModel: "Which model is it exactly?",
  problemDescription: "Now tell me what's going wrong with it.",
  problemStartedAt: "When did you first notice the problem?",
  urgency: "How soon do you need it back?",
  serialNumber: "Next, the device's serial number or IMEI, so we can look up its warranty.",
  purchaseInvoice: "Please upload your purchase invoice.",
  serviceCentre: "Pick the service centre that suits you best.",
  email: "Where should we send updates about your claim?",
  additionalPhotos: "If you have photos of the device or the damage, you can add them here. This is optional.",
  additionalNotes: "Anything else the technician should know? This is optional too.",
};

export interface LeadInContext {
  /** The first card the planner opens since the call ended (the hand-off to chat, architecture §5.3). */
  afterCall: boolean;
  /** Opened by the 60 s safety net during a call (P4-T01). */
  inCall: boolean;
}

export function leadIn(field: RecordFieldId, { afterCall, inCall }: LeadInContext): string {
  if (inCall) return `While we talk, you can fill this in here: ${FIELDS[field].card.label}`;
  const text = LEAD_INS[field];
  return afterCall ? `Thanks for the call. Let's finish the rest here in chat. ${text}` : text;
}

/** The planner opened a card the call agent asked for (P5's request_chat_input). */
export const agentCardLeadIn = (field: RecordFieldId): string => `I've sent you a box for your ${FIELDS[field].label}.`;

export const RESUME_MESSAGE = "OK, let's carry on.";
export const CHAT_START_MESSAGE = "No problem if you'd rather not call. We can do everything here in chat.";
export const EDIT_LEAD_IN = (field: RecordFieldId) => `Sure. What's the correct ${FIELDS[field].label}?`;
export const STILL_MISSING_MESSAGE = "Something still needs your answer before the claim can be submitted.";

// ---------------------------------------------------------------------------------------------------------------------
// Answers

/** The user's answer as one line of the thread (a replayed answer bubble, protocol.md §3.3 `message` role user). */
export function answerText(spec: CardSpec, value: unknown, fileNames: readonly string[] = []): string {
  if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) return "(skipped)";
  if (spec.kind === InputKind.CONFIRM) return value === true ? "Yes" : "No";
  if (spec.kind === InputKind.FILE) {
    if (fileNames.length > 0) return truncate(fileNames.join(", "), 500);
    const count = Array.isArray(value) ? value.length : 1;
    return count === 1 ? "1 file" : `${count} files`;
  }
  const values = Array.isArray(value) ? value : [value];
  const labels = values.map((item) => spec.options?.find((option) => option.value === item)?.label ?? String(item));
  return truncate(cleanText(labels.join(", "), { multiline: true }), 1000) || "(empty)";
}

const get = (value: unknown, key: string): unknown => (typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined);

/** "Thanks, …": the acknowledgement of a valid answer, built from the normalized value (only validated facts). */
export function acknowledgement(field: RecordFieldId, normalized: unknown, skipped: boolean): string {
  if (skipped) return "No problem, we'll skip that.";
  switch (field) {
    case "serialNumber":
      return get(normalized, "kind") === "imei" ? "Thanks, I've got your IMEI." : "Thanks, I've got your serial number.";
    case "purchaseInvoice":
      return "Thanks, your invoice is uploaded.";
    case "serviceCentre":
      return `Great, ${String(get(normalized, "name") ?? "that centre")} it is.`;
    case "email":
      return `Thanks, updates will go to ${String(normalized)}.`;
    case "additionalPhotos":
      return Array.isArray(normalized) && normalized.length === 1 ? "Thanks, I've added your photo." : "Thanks, I've added your photos.";
    case "additionalNotes":
      return "Thanks, I've added your note for the technician.";
    case "deviceModel": {
      const name = [get(normalized, "brand"), get(normalized, "model")].filter((part) => typeof part === "string").join(" ");
      return name ? `Got it, ${name}.` : "No problem, we'll note that you're not sure of the model.";
    }
    default:
      return "Got it, thanks.";
  }
}

/** The third invalid answer (D14): the card is cancelled and the field is left for the team. */
export const tooManyAttempts = (field: RecordFieldId): string =>
  `That ${FIELDS[field].label} still doesn't look right, so I'll leave it for our team to check. Let's carry on.`;

/** Nothing more can be asked, but a required field couldn't be accepted, so the claim can't be confirmed (D16). */
export const STALLED_MESSAGE =
  "That's everything I can collect here. Some details couldn't be confirmed, so our team will review your claim and get in touch.";

// ---------------------------------------------------------------------------------------------------------------------
// Summary and outcome

const KB = 1024;
const size = (bytes: unknown) => (typeof bytes === "number" ? (bytes < KB * KB ? `${Math.max(1, Math.round(bytes / KB))} KB` : `${(bytes / (KB * KB)).toFixed(1)} MB`) : "");
const FILE_KIND: Record<string, string> = { "application/pdf": "PDF", "image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WebP" };
const optionLabel = (field: RecordFieldId, value: unknown) => FIELDS[field].card.options?.find((option) => option.value === value)?.label ?? String(value);

/** One field's value as the summary shows it (capped, so the whole summary stays short). */
export function summaryValue(field: RecordFieldId, resolved: ResolvedField): string {
  if (resolved.status === "skipped" || resolved.status === "missing") return FIELDS[field].required ? "missing" : "none";
  if (resolved.status !== "valid") return `not accepted (${resolved.status})`;
  const v = resolved.value;
  let text: string;
  switch (field) {
    case "deviceType":
      text = optionLabel(field, v);
      break;
    case "deviceModel":
      text = [get(v, "brand"), get(v, "model")].filter((part) => typeof part === "string").join(" ") || "not known";
      break;
    case "problemDescription":
      text = String(get(v, "summary") ?? "");
      break;
    case "problemStartedAt":
      text = `${String(get(v, "date"))}${get(v, "precision") === "day" ? "" : ` (around then, by ${String(get(v, "precision"))})`}`;
      break;
    case "urgency":
      text = optionLabel(field, get(v, "level"));
      break;
    case "serialNumber":
      text = `${get(v, "kind") === "imei" ? "IMEI" : "Serial"} ${String(get(v, "value"))}`;
      break;
    case "purchaseInvoice":
      text = `${FILE_KIND[String(get(v, "mime"))] ?? "file"}, ${size(get(v, "size"))}`;
      break;
    case "serviceCentre":
      text = `${String(get(v, "name"))}, ${String(get(v, "city"))}`;
      break;
    case "additionalPhotos":
      text = Array.isArray(v) ? (v.length === 1 ? "1 photo" : `${v.length} photos`) : "none";
      break;
    default:
      text = String(v);
  }
  return truncate(cleanText(text), SUMMARY_VALUE_CHARS);
}

/** 11 lines of at most this much stay well under the 2,000-character message limit (protocol.md §7). */
export const SUMMARY_VALUE_CHARS = 140;

export function summaryMessage(fields: Readonly<Record<RecordFieldId, ResolvedField>>): string {
  const lines = RECORD_FIELD_IDS.map((id) => `• ${fieldName(id)}: ${summaryValue(id, fields[id])}`);
  return ["Here's your claim:", ...lines].join("\n");
}

export function finalizedMessage(outcome: Outcome): string {
  switch (outcome) {
    case Outcome.COMPLETED:
      return "Thanks, your claim is submitted. We'll email you with updates.";
    case Outcome.NEEDS_REVIEW:
      return "Thanks, your claim is submitted. A member of our team will review it and get in touch.";
    case Outcome.OPTED_OUT:
      return "OK, I've stopped your claim. What you shared so far has been kept.";
    case Outcome.PARTIAL:
      return "We've saved your claim as it is. You can come back to this page to finish it.";
  }
}

/** Why outstanding cards are closed when the session is finalized (inputCancel reason). */
export const FINALIZED_CANCEL_REASON = "the claim is closed";

// ---------------------------------------------------------------------------------------------------------------------
// Call endings (P5-T09): the chat says why a call ended when the user didn't end it themselves. After a hang-up or
// the agent's goodbye, the planner's first card carries "Thanks for the call…" instead.

const CALL_ENDED: Record<string, string | null> = {
  hangup: null,
  agent_ended: null,
  opted_out: null,
  network: "The call dropped. Let's continue here in chat.",
  silence: "I didn't hear anything for a while, so I ended the call. Let's continue here in chat.",
  max_duration: "We reached the time limit for a call. Let's finish here in chat.",
  provider_error: "I'm having trouble with the voice line, so let's continue here in chat.",
  server_restart: "The call was interrupted; let's continue here.",
};

export const callEndedMessage = (reason: string): string | null => CALL_ENDED[reason] ?? null;

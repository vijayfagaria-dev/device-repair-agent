// What the call agent says from templates rather than the model (D13): acknowledgements built only from validated
// tool results, silence reprompts, and closing lines. Short, spoken English (P5-T05 style rules).
import type { RecordFieldId } from "@device-repair/shared/fields";
import { FIELDS } from "../domain/fields.js";

const get = (value: unknown, key: string): unknown => (typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined);

/** A validated spoken value, acknowledged (acknowledge-then-ask). Never echoes identifiers. */
export function savedAck(field: RecordFieldId, normalized: unknown): string {
  switch (field) {
    case "deviceModel": {
      const name = [get(normalized, "brand"), get(normalized, "model")].filter((p) => typeof p === "string").join(" ");
      return name ? `Got it, ${name}.` : "No problem.";
    }
    case "problemDescription":
      return "I'm sorry to hear that.";
    case "urgency":
      return "Understood.";
    case "serviceCentre":
      return typeof get(normalized, "name") === "string" ? `Got it, ${String(get(normalized, "name"))}.` : "Got it.";
    default:
      return "Got it.";
  }
}

export const cardSentAck = (field: string): string =>
  field === "submitConfirmation"
    ? "I've put a summary in the chat. Please check it and tap Yes to submit."
    : `I've sent a box to your chat for the ${Object.hasOwn(FIELDS, field) ? FIELDS[field as RecordFieldId].label : "details"}.`;

export const typeItAck = (field: RecordFieldId): string => `Thanks. Please type your ${FIELDS[field].label} in the chat box I've sent, so I get it exactly right.`;

export const OPTED_OUT_GOODBYE = "OK, I've stopped your claim. What you've shared so far is kept. Goodbye.";
export const SUBMITTED_GOODBYE = "Your claim is submitted. Thank you, goodbye.";
export const REPROMPTS = ["Are you still there? Take your time.", "If now isn't a good time, we can finish in the chat. Are you there?"];
export const PROVIDER_TROUBLE = "I'm having trouble hearing you, so let's continue in the chat.";

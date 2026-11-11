// The per-turn state message (P5-T05, architecture §6): a trailing system message holding everything that changes,
// so the system + tools prefix stays byte-stable. Compact JSON: local IST time, what is collected (display values;
// files as "PDF, 178 KB", never a path or link), what is missing, identifiers only heard on the call, pending chat
// cards, chat events since the last turn, and whether this is a returning call. Anything the customer typed in chat
// is wrapped as data (<chat_input>), with angle brackets escaped so it can't close the tag (prompt-injection hygiene).
import { RECORD_FIELD_IDS, type RecordFieldId } from "@device-repair/shared/fields";
import type { StoredInputRequest } from "../db/repos/inputRequests.js";
import type { Session } from "../db/repos/sessions.js";
import type { ResolvedField } from "../domain/conflicts.js";
import { FIELDS, REQUIRED_RECORD_FIELDS } from "../domain/fields.js";
import type { LlmMessage } from "../voice/types.js";
import { fieldState } from "./chatPlanner.js";
import { summaryValue } from "./chatTemplates.js";

/** One chat event since the agent's last turn (P5-T08), as the call engine collected it from the hub. */
export interface ChatEventNote {
  field: string;
  result: "accepted" | "rejected" | "cancelled" | "skipped";
  /** Rejections of this field's card so far (voice help after 2+). */
  rejections?: number;
}

export interface StateInput {
  now: Date;
  /** When this call started (ms since the epoch). */
  callStartedAt: number;
  session: Pick<Session, "status" | "outcome">;
  fields: Readonly<Record<RecordFieldId, ResolvedField>>;
  requests: readonly StoredInputRequest[];
  isReturningCall: boolean;
  /** For a returning call: the last thing the agent said on the previous call. */
  lastAgentLine?: string | null;
  newChatEvents: readonly ChatEventNote[];
}

const escapeTags = (text: string) => text.replace(/[<>]/g, (c) => (c === "<" ? "‹" : "›"));
/** Text the customer typed, as data: `<chat_input field="email">…</chat_input>`, brackets escaped. */
export const asChatData = (field: string, text: string): string => `<chat_input field="${field}">${escapeTags(text)}</chat_input>`;
/** What the customer said on the call (it comes from their own words), as data too (P5 review #15). */
export const asSpokenData = (field: string, text: string): string => `<customer_words field="${field}">${escapeTags(text)}</customer_words>`;

const IST = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", weekday: "long", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** "2026-11-10 13:45 Tuesday" in IST (D14: date logic runs in Asia/Kolkata). */
export function istLocalTime(now: Date): string {
  const part = (type: string) => IST.formatToParts(now).find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")} ${part("weekday")}`;
}

export function buildState(input: StateInput): Record<string, unknown> {
  const state = fieldState({ requests: input.requests, candidates: [] });
  const { fields } = input;
  const collected: Record<string, string> = {};
  const unverified: string[] = [];
  for (const id of RECORD_FIELD_IDS) {
    const field = fields[id];
    if (field.status === "valid") {
      const text = summaryValue(id, field);
      collected[id] = field.source === "chat" ? asChatData(id, text) : asSpokenData(id, text);
    } else if (field.status === "unverified") {
      unverified.push(id);
    } else if (field.status === "skipped") {
      collected[id] = "skipped";
    }
  }
  const stuck = REQUIRED_RECORD_FIELDS.filter((id) => fields[id].status !== "valid" && state.stuck(id));
  const missing = REQUIRED_RECORD_FIELDS.filter((id) => fields[id].status !== "valid" && !stuck.includes(id));
  const pending = input.requests.filter((r) => r.status === "open" || r.status === "queued").map((r) => r.field);
  const claimStatus = input.session.status === "active" ? "collecting" : input.session.outcome === "optedOut" ? "stopped" : "submitted";
  return {
    localTime: istLocalTime(input.now),
    callSecondsElapsed: Math.max(0, Math.round((input.now.getTime() - input.callStartedAt) / 1000)),
    claimStatus,
    isReturningCall: input.isReturningCall,
    ...(input.isReturningCall && input.lastAgentLine ? { lastQuestionOnPreviousCall: input.lastAgentLine.slice(0, 200) } : {}),
    collected,
    missing,
    // Heard on the call but must be typed in the chat card (D13 identifier rule).
    heardButMustBeTyped: unverified,
    givenUp: stuck,
    pendingChatCards: pending,
    readyToSubmit: missing.length === 0 && stuck.length === 0 && !pending.includes("submitConfirmation") && claimStatus === "collecting",
    newChatEvents: input.newChatEvents.map((e) => ({ field: e.field, result: e.result, ...(e.rejections ? { rejections: e.rejections } : {}) })),
  };
}

export function stateMessage(input: StateInput): LlmMessage {
  return { role: "system", content: `STATE ${JSON.stringify(buildState(input))}` };
}

/** Field labels the agent uses when it speaks a templated acknowledgement (acknowledge-then-ask, D13). */
export const spokenLabel = (field: string): string => (Object.hasOwn(FIELDS, field) ? FIELDS[field as RecordFieldId].label : "that");

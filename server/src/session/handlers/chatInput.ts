// The commands the chat socket dispatches for client messages (protocol.md §3.4), and their reply contract (P3-T04).
// Handlers: submitChatInput.ts (P4-T02) and optOut.ts (P4-T05).
import type { InputValue, Outcome } from "@device-repair/shared/protocol";

export interface SubmitChatInput {
  type: "SubmitChatInput";
  requestId: string;
  field: string;
  value: InputValue;
}

/**
 * - `accepted` / `rejected`: decided and persisted; the client hears about it through the committed events
 *   (`chat.message`, `input.rejected` → inputError, …), live and on replay.
 * - `stale`: the request isn't the session's open one; nothing is written, so the socket answers directly with
 *   inputError "This request is no longer active" (protocol.md §3.4).
 */
export type SubmitChatInputReply =
  | {
      status: "accepted";
      /** Set when this answer finalized the session (Yes on a confirm card, P6-T01). */
      finalized?: { revision: number; outcome: Outcome; schemaProblems?: readonly { path: string; keyword: string; message: string }[] };
    }
  | { status: "rejected" }
  /**
   * `open`: the session's open card when it isn't the one answered. The socket sends it again after the error, so a
   * page that still shows the stale card (an answer in flight when the Stop flow paused it) shows the right one.
   */
  | { status: "stale"; message: string; open?: OpenCardRef };

/** The open card as the socket re-sends it (protocol.md §3.3 `inputRequest`). */
export interface OpenCardRef {
  id: string;
  field: string;
  spec: Record<string, unknown>;
}

export interface OptOutRequested {
  type: "OptOutRequested";
}

export const STALE_REQUEST_MESSAGE = "This request is no longer active.";

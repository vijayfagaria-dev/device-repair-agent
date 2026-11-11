// Chat cards (P4-T01): the planner's `Reconcile` command and the call agent's `RequestInput` command.
//
// Reconcile applies planChat under the session lock (one transaction), so the desired state is computed from exactly
// what is committed and applied atomically: a second Reconcile right after finds nothing to do and writes nothing.
// (The plan describes reconcile as issuing RequestInput/CancelInput commands; doing both in one command is the same
// result without a window between them.)
//
// RequestInput is what the call agent's request_chat_input tool dispatches (P5-T05): it queues a card, and the
// planner opens queued cards one at a time. The controller refuses a field that isn't a chat card or is already done.
import { CHAT_FIELDS, OPTIONAL_FIELDS } from "@device-repair/shared/fields";
import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";
import { type ChatMode, fieldState, isRecordField, nextRequestId, planChat } from "../../agent/chatPlanner.js";
import { ControlField, submitCard } from "../../agent/chatTemplates.js";
import type { JsonObject } from "../../db/repos/rows.js";
import { listActiveSessionIds } from "../../db/repos/sessions.js";
import { FIELDS } from "../../domain/fields.js";
import { missingRequired } from "../../domain/outcome.js";
import type { CommandProcessor, Handler, Reaction } from "../commands.js";

export interface Reconcile {
  type: "Reconcile";
}

export interface ReconcileReply {
  mode: ChatMode;
  changed: boolean;
}

export const reconcileHandler: Handler<Reconcile, ReconcileReply> = (snapshot) => {
  const { mode, events } = planChat(snapshot);
  return { events, reply: { mode, changed: events.length > 0 } };
};

/**
 * The post-commit reaction that keeps every session's chat reconciled (D11): after every command that changed
 * something, and on demand (chat connect, boot; `command` null). Not after a Reconcile, which already left the session
 * reconciled, nor after a no-op, which changed nothing.
 */
export function reconcileReaction(processor: CommandProcessor): Reaction {
  return async (sessionId, update, command) => {
    if (command?.type === "Reconcile") return;
    if (command && update === null) return;
    await processor.dispatch<ReconcileReply>(sessionId, { type: "Reconcile" } satisfies Reconcile);
  };
}

/**
 * Boot reconciliation (D11, architecture §5.5 step 3): every active session gets its reconcile, so a card that should
 * be open after a crash (for example right after a call ended) is opened before the server takes traffic. One session
 * at a time: each is a short transaction, and a failure is logged without stopping the others.
 */
export async function reconcileActiveSessions(pool: pg.Pool, processor: CommandProcessor, log: FastifyBaseLogger): Promise<number> {
  const ids = await listActiveSessionIds(pool);
  for (const id of ids) await processor.react(id);
  log.info({ sessions: ids.length }, "boot reconciliation complete");
  return ids.length;
}

// ---------------------------------------------------------------------------------------------------------------------

/** Fields the call agent may send a card for: the chat fields, the optional ones, and the submit confirmation. */
const AGENT_CARD_FIELDS = new Set<string>([...CHAT_FIELDS, ...OPTIONAL_FIELDS, ControlField.SUBMIT]);

export interface RequestInput {
  type: "RequestInput";
  field: string;
}

export type RequestInputReply =
  | { status: "queued"; requestId: string }
  | { status: "alreadyPending"; requestId: string }
  | { status: "refused"; reason: "notActive" | "notAChatField" | "alreadyProvided" | "tooManyAttempts" | "notReady" };

export const requestInputHandler: Handler<RequestInput, RequestInputReply> = (snapshot, { field }) => {
  if (snapshot.session.status !== "active") return { reply: { status: "refused", reason: "notActive" } };
  if (!AGENT_CARD_FIELDS.has(field)) return { reply: { status: "refused", reason: "notAChatField" } };
  const pending = snapshot.requests.find((request) => request.field === field && (request.status === "open" || request.status === "queued"));
  if (pending) return { reply: { status: "alreadyPending", requestId: pending.id } };

  const state = fieldState(snapshot);
  let spec: JsonObject;
  if (isRecordField(field)) {
    const status = state.resolved[field].status;
    if (status === "valid" || status === "skipped") return { reply: { status: "refused", reason: "alreadyProvided" } };
    if (state.stuck(field)) return { reply: { status: "refused", reason: "tooManyAttempts" } };
    spec = { ...FIELDS[field].card } as unknown as JsonObject;
  } else {
    // The confirmation card is only offered when every required field is valid (D16).
    if (missingRequired(state.resolved).length > 0) return { reply: { status: "refused", reason: "notReady" } };
    spec = { ...submitCard() } as unknown as JsonObject;
  }
  const requestId = nextRequestId(snapshot, field);
  return {
    events: [{ type: "input.queued", channel: "call", payload: { by: "agent" }, inputRequest: { id: requestId, field, spec, status: "queued" } }],
    reply: { status: "queued", requestId },
  };
};

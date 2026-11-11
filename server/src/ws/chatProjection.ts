// What the chat socket sends (protocol.md §3.3), from committed events (live) or stored rows (replay, §4).
// Both paths build their messages with the same functions below, so a replayed message is byte-identical to the one
// sent live: same id, same fields. Ids follow protocol.md §1.1 and are stable across reconnects and restarts.
import {
  type ChatMessage,
  ChatServerMessageType,
  type ChatServerMessage,
  type ChatTranscriptMessage,
  type InputCancel,
  type InputError,
  type InputRequest,
  type RecordMessage,
  type FinalRecord,
  Role,
  type SessionStateMessage,
  type SyncDoneMessage,
} from "@device-repair/shared/protocol";
import type { SessionEvent } from "../db/repos/events.js";
import type { Session } from "../db/repos/sessions.js";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const toRole = (value: unknown): Role => (value === Role.USER ? Role.USER : Role.AGENT);

export function chatMessageWire(row: { id: string; role: string; text: string; requestId?: string | null }): ChatMessage {
  const message: ChatMessage = { type: ChatServerMessageType.MESSAGE, id: `m_${row.id}`, role: toRole(row.role), text: row.text };
  if (row.role === Role.USER && row.requestId) message.requestId = row.requestId;
  return message;
}

/** Only final lines are stored, so a replayed or projected transcript line is always final. */
export function transcriptWire(row: { id: string; role: string; text: string }): ChatTranscriptMessage {
  return { type: ChatServerMessageType.TRANSCRIPT, id: row.id, role: toRole(row.role), text: row.text, final: true };
}

/** The card: the stored spec (the catalog's card, P2-T01) plus the request's id and field. */
export function inputRequestWire(request: { id: string; field: string; spec: Record<string, unknown> }): InputRequest {
  const { type: _type, id: _id, field: _field, ...spec } = request.spec;
  return { ...(spec as Omit<InputRequest, "type" | "id" | "field">), type: ChatServerMessageType.INPUT_REQUEST, id: request.id, field: request.field };
}

export const inputErrorWire = (requestId: string, attempt: number, message: string): InputError => ({
  type: ChatServerMessageType.INPUT_ERROR,
  id: `err_${requestId}_${attempt}`,
  requestId,
  message,
});

export function inputCancelWire(requestId: string, reason?: string): InputCancel {
  const message: InputCancel = { type: ChatServerMessageType.INPUT_CANCEL, id: `cancel_${requestId}`, requestId };
  if (reason) message.reason = reason;
  return message;
}

export const recordWire = (revision: number, record: Record<string, unknown>): RecordMessage => ({
  type: ChatServerMessageType.RECORD,
  id: `rec_${revision}`,
  record: record as unknown as FinalRecord,
});

/**
 * The session as the client sees it. `voiceAvailable` is true here; the chat socket sets the live value from the
 * quota guard when it sends (P10-T03). `notice` is null until the server writes notices (P8-T01).
 */
export function sessionStateWire(session: Pick<Session, "version" | "status" | "activeCallId" | "outcome" | "currentRevision">): SessionStateMessage {
  return {
    type: ChatServerMessageType.SESSION_STATE,
    id: `state_${session.version}`,
    status: session.status,
    callActive: session.activeCallId !== null,
    outcome: session.outcome,
    revision: session.currentRevision > 0 ? session.currentRevision : null,
    voiceAvailable: true,
    notice: null,
  };
}

export const syncDoneWire = (lastSeq: number): SyncDoneMessage => ({ type: ChatServerMessageType.SYNC_DONE, id: `sync_${lastSeq}`, lastSeq });

/** True when two sessionState messages show the client the same thing (the id, i.e. the version, aside). */
export function sameSessionState(a: SessionStateMessage, b: SessionStateMessage): boolean {
  return (
    a.status === b.status &&
    a.callActive === b.callActive &&
    a.outcome === b.outcome &&
    a.revision === b.revision &&
    a.voiceAvailable === b.voiceAvailable &&
    a.notice === b.notice
  );
}

/** The record a command committed, as carried on the hub update (not in an event payload, P6-T01). */
export type CommittedRecord = { revision: number; payload: Readonly<Record<string, unknown>> };

/**
 * One committed event → the chat messages it means for the client (D12 event types). Events that aren't
 * chat-visible (session.created, timer.fired, field.candidate, input.paused, …) give nothing.
 *
 * `session.finalized` projects to the `record` message (id `rec_<revision>`, P6-T03) when the update carries that
 * revision's record. The record isn't in the event payload, so the timeline never holds its signed file URLs; replay
 * reads the latest from the records table instead. A new revision has a new id, and the page replaces the record card
 * it shows rather than adding a second.
 */
export function toChatMessages(event: SessionEvent, record?: CommittedRecord): ChatServerMessage[] {
  const { payload } = event;
  switch (event.type) {
    case "chat.message": {
      const message = payload.message;
      if (!isObject(message) || !str(message.id) || !str(message.role) || typeof message.text !== "string") return [];
      return [chatMessageWire({ id: message.id as string, role: message.role as string, text: message.text, requestId: str(message.requestId) ?? null })];
    }
    case "transcript.final": {
      const line = payload.line;
      if (!isObject(line) || !str(line.id) || typeof line.text !== "string") return [];
      return [transcriptWire({ id: line.id as string, role: String(line.role), text: line.text })];
    }
    // A card opened (input.requested) or brought back after the Stop flow paused it (input.resumed, P4-T05): the same
    // id, so a page that still holds it shows that card again.
    case "input.requested":
    case "input.resumed": {
      const request = payload.request;
      if (!isObject(request) || request.status !== "open" || !str(request.id) || !str(request.field) || !isObject(request.spec)) return [];
      return [inputRequestWire({ id: request.id as string, field: request.field as string, spec: request.spec })];
    }
    case "input.rejected": {
      const requestId = str(payload.requestId);
      const attempt = payload.attempt;
      if (!requestId || typeof attempt !== "number") return [];
      return [inputErrorWire(requestId, attempt, str(payload.message) ?? "Please check this value and try again.")];
    }
    case "input.cancelled": {
      const requestId = str(payload.requestId) ?? (isObject(payload.request) ? str(payload.request.id) : undefined);
      return requestId ? [inputCancelWire(requestId, str(payload.reason))] : [];
    }
    case "session.finalized":
      return record && payload.revision === record.revision ? [recordWire(record.revision, record.payload as Record<string, unknown>)] : [];
    default:
      return [];
  }
}

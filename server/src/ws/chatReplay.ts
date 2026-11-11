// The replay a /chat connection starts with (protocol.md §4 step 3), read from the database.
//
// Consistency with the live stream: the caller subscribes to the hub BEFORE calling this. Everything is read in one
// read-only snapshot (one connection, REPEATABLE READ), so the history, the open card, the record and the session
// state all reflect exactly the events up to `lastSeq`. Every event is then in exactly one of: the replay
// (seq ≤ lastSeq) or the buffered live updates (seq > lastSeq, which the socket filters by seq), and the thread keeps
// commit order: a card opened after lastSeq arrives live, after the messages committed before it.
import type { ChatServerMessage, SessionStateMessage } from "@device-repair/shared/protocol";
import { listChatMessages } from "../db/repos/chatMessages.js";
import { getOpenInputRequest } from "../db/repos/inputRequests.js";
import { getLatestRecord } from "../db/repos/records.js";
import { getSession } from "../db/repos/sessions.js";
import { listTranscriptLines } from "../db/repos/transcriptLines.js";
import type pg from "pg";
import { withTx } from "../db/tx.js";
import { chatMessageWire, inputRequestWire, recordWire, sessionStateWire, transcriptWire } from "./chatProjection.js";

export interface Replay {
  /** The last event seq the history reflects (syncDone.lastSeq). */
  lastSeq: number;
  /** Chat messages and final transcript lines, merged in event order (step 3.1). */
  history: ChatServerMessage[];
  /** The open card, if any (3.2). */
  openRequest: ChatServerMessage | null;
  /** The latest record revision, if any (3.3). */
  record: ChatServerMessage | null;
  /** The session as read for this replay (3.4). */
  state: SessionStateMessage;
}

export async function loadReplay(pool: pg.Pool, sessionId: string): Promise<Replay> {
  // One statement at a time: a transaction is one connection.
  const read = await withTx(
    pool,
    async (tx) => {
      const { rows } = await tx.query<{ seq: number }>("SELECT COALESCE(max(seq), 0)::int AS seq FROM events WHERE session_id = $1", [sessionId]);
      return {
        lastSeq: Number(rows[0]?.seq ?? 0),
        messages: await listChatMessages(tx, sessionId),
        lines: await listTranscriptLines(tx, sessionId),
        open: await getOpenInputRequest(tx, sessionId),
        record: await getLatestRecord(tx, sessionId),
        session: await getSession(tx, sessionId),
      };
    },
    { snapshot: true },
  );
  const { lastSeq, messages, lines, open, record, session } = read;
  if (!session) throw new Error("session not found during replay");

  // Both lists are already in event order; merge them. The snapshot holds nothing newer than lastSeq, and the filter
  // keeps that true even if a caller ever reads outside one.
  const items = [
    ...messages.filter((m) => m.eventSeq <= lastSeq).map((m) => ({ seq: m.eventSeq, message: chatMessageWire(m) as ChatServerMessage })),
    ...lines.filter((l) => l.eventSeq <= lastSeq).map((l) => ({ seq: l.eventSeq, message: transcriptWire(l) as ChatServerMessage })),
  ].sort((a, b) => a.seq - b.seq);

  return {
    lastSeq,
    history: items.map((item) => item.message),
    openRequest: open ? inputRequestWire(open) : null,
    record: record ? recordWire(record.revision, record.payload) : null,
    state: sessionStateWire(session),
  };
}

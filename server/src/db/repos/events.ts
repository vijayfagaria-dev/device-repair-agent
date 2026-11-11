// events: the append-only session timeline (D12). seq is per session, consecutive from 1.
import { z } from "zod";
import type { Queryable, Tx } from "../tx.js";
import { int, jsonObject, type JsonObject, parseReturnedRow, parseRows, timestamp, toJsonParam } from "./rows.js";

export const EVENT_CHANNELS = ["call", "chat", "system"] as const;
export type EventChannel = (typeof EVENT_CHANNELS)[number];

const eventSchema = z.object({
  sessionId: z.string(),
  seq: int,
  type: z.string(),
  channel: z.enum(EVENT_CHANNELS),
  payload: jsonObject,
  createdAt: timestamp,
});
export type SessionEvent = z.infer<typeof eventSchema>;

export interface NewEvent {
  sessionId: string;
  type: string;
  channel: EventChannel;
  payload?: JsonObject;
  /** From nextEventSeq, when rows referring to the event are written first (deferred foreign keys, D11). */
  seq?: number;
}

const COLUMNS = `session_id AS "sessionId", seq, type, channel, payload, created_at AS "createdAt"`;

/**
 * The next seq for a session. Only correct while the transaction holds the session lock (lockSession): two
 * unlocked callers would compute the same value, and the second insert would fail on UNIQUE(session_id, seq).
 */
export async function nextEventSeq(tx: Tx, sessionId: string): Promise<number> {
  const { rows } = await tx.query<{ seq: number }>(
    "SELECT COALESCE(max(seq), 0)::int + 1 AS seq FROM events WHERE session_id = $1",
    [sessionId],
  );
  return int.parse(rows[0]?.seq);
}

/** Appends an event at the next seq (or the given one). Requires the session lock, like nextEventSeq. */
export async function appendEvent(tx: Tx, event: NewEvent): Promise<SessionEvent> {
  const seq = event.seq ?? (await nextEventSeq(tx, event.sessionId));
  const { rows } = await tx.query(
    `INSERT INTO events (session_id, seq, type, channel, payload) VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING ${COLUMNS}`,
    [event.sessionId, seq, event.type, event.channel, toJsonParam(event.payload ?? {})],
  );
  return parseReturnedRow("events", eventSchema, rows);
}

/** Events in seq order, optionally only those after a known seq. */
export async function listEvents(db: Queryable, sessionId: string, options: { afterSeq?: number } = {}): Promise<SessionEvent[]> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM events WHERE session_id = $1 AND seq > $2 ORDER BY seq`, [
    sessionId,
    options.afterSeq ?? 0,
  ]);
  return parseRows("events", eventSchema, rows);
}

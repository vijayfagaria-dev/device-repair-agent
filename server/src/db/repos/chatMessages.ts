// chat_messages: agent and user chat messages, replayed in event order (protocol.md §4).
import { Role } from "@device-repair/shared/protocol";
import { z } from "zod";
import type { Queryable } from "../tx.js";
import { int, parseReturnedRow, parseRows, timestamp } from "./rows.js";

const chatMessageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  eventSeq: int,
  role: z.enum(Role),
  text: z.string(),
  requestId: z.string().nullable(),
  createdAt: timestamp,
});
export type StoredChatMessage = z.infer<typeof chatMessageSchema>;

export interface NewChatMessage {
  id: string;
  sessionId: string;
  /** The `chat.message` event; it may be appended later in the same transaction (deferred FK). */
  eventSeq: number;
  role: Role;
  text: string;
  requestId?: string | null;
}

const COLUMNS = `id, session_id AS "sessionId", event_seq AS "eventSeq", role, text, request_id AS "requestId",
  created_at AS "createdAt"`;

export async function insertChatMessage(db: Queryable, message: NewChatMessage): Promise<StoredChatMessage> {
  const { rows } = await db.query(
    `INSERT INTO chat_messages (id, session_id, event_seq, role, text, request_id) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${COLUMNS}`,
    [message.id, message.sessionId, message.eventSeq, message.role, message.text, message.requestId ?? null],
  );
  return parseReturnedRow("chat_messages", chatMessageSchema, rows);
}

/** Messages in event order (the replay order). */
export async function listChatMessages(db: Queryable, sessionId: string): Promise<StoredChatMessage[]> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM chat_messages WHERE session_id = $1 ORDER BY event_seq, id`, [
    sessionId,
  ]);
  return parseRows("chat_messages", chatMessageSchema, rows);
}

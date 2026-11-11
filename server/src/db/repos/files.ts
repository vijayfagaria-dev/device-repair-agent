// files + file_blobs: uploaded files (D10). Metadata and bytes are separate tables, written together.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Queryable, Tx } from "../tx.js";
import { int, jsonObject, type JsonObject, parseOptionalRow, parseReturnedRow, parseRows, timestamp, toOptionalJsonParam } from "./rows.js";

export const FILE_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"] as const;
export type FileMimeType = (typeof FILE_MIME_TYPES)[number];

const fileSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  mime: z.enum(FILE_MIME_TYPES),
  size: int,
  sha256: z.string(),
  originalName: z.string().nullable(),
  checkResult: jsonObject.nullable(),
  createdAt: timestamp,
});
export type StoredFile = z.infer<typeof fileSchema>;

export interface NewFile {
  id: string;
  sessionId: string;
  /** The sniffed type (never the client's claim). */
  mime: FileMimeType;
  bytes: Buffer;
  originalName?: string | null;
  checkResult?: JsonObject | null;
}

const COLUMNS = `id, session_id AS "sessionId", mime, size, sha256, original_name AS "originalName",
  check_result AS "checkResult", created_at AS "createdAt"`;

/**
 * Stores metadata and bytes in the caller's transaction, so neither exists without the other. Size and SHA-256
 * are computed from the bytes here, so they always match what is stored.
 */
export async function insertFile(tx: Tx, file: NewFile): Promise<StoredFile> {
  const sha256 = createHash("sha256").update(file.bytes).digest("hex");
  const { rows } = await tx.query(
    `INSERT INTO files (id, session_id, mime, size, sha256, original_name, check_result)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING ${COLUMNS}`,
    [file.id, file.sessionId, file.mime, file.bytes.length, sha256, file.originalName ?? null, toOptionalJsonParam(file.checkResult)],
  );
  await tx.query("INSERT INTO file_blobs (file_id, bytes) VALUES ($1, $2)", [file.id, file.bytes]);
  return parseReturnedRow("files", fileSchema, rows);
}

/** Metadata only (never reads the blob). */
export async function getFile(db: Queryable, id: string): Promise<StoredFile | null> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM files WHERE id = $1`, [id]);
  return parseOptionalRow("files", fileSchema, rows);
}

export async function getFileBytes(db: Queryable, id: string): Promise<Buffer | null> {
  const { rows } = await db.query<{ bytes: unknown }>("SELECT bytes FROM file_blobs WHERE file_id = $1", [id]);
  return rows[0] === undefined ? null : z.instanceof(Buffer).parse(rows[0].bytes);
}

/**
 * Deletes uploads nothing refers to: older than `olderThan` and named by no answer (candidate) of their session. An
 * upload that was never submitted only uses the free-tier storage budget (D10). Bytes go with the row (ON DELETE CASCADE).
 * A file a record carries is always named by a candidate, so records never lose a file.
 */
export async function deleteOrphanFiles(db: Queryable, olderThan: Date): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM files f
     WHERE f.created_at < $1
       AND NOT EXISTS (
         SELECT 1 FROM field_candidates c
         WHERE c.session_id = f.session_id AND position(f.id in c.normalized::text) > 0
       )`,
    [olderThan],
  );
  return rowCount ?? 0;
}

/** The session's files (metadata only), oldest first. */
export async function listFiles(db: Queryable, sessionId: string): Promise<StoredFile[]> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM files WHERE session_id = $1 ORDER BY created_at, id`, [sessionId]);
  return parseRows("files", fileSchema, rows);
}

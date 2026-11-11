// Upload storage (D10, P4-T03): file metadata (`files`) and bytes (`file_blobs`) in Postgres, written in one
// transaction, within a global upload budget (default 600 MB, keeping headroom in Neon's 1 GB) and a per-session cap.
// The budget check and the insert happen under one transaction-scoped advisory lock (it works through Neon's pooler,
// D09), so concurrent uploads, also on two instances during a deploy, can't together overshoot either limit.
import type pg from "pg";
import { getFile, getFileBytes, insertFile, type FileMimeType, type StoredFile } from "../db/repos/files.js";
import { withTx } from "../db/tx.js";

/** D10: at most 12 files per session (protocol.md §7). */
export const MAX_FILES_PER_SESSION = 12;
/** UPLOAD_BUDGET_BYTES default (D10). */
export const DEFAULT_UPLOAD_BUDGET_BYTES = 600 * 1024 * 1024;
/** Serializes upload inserts: the budget is a sum over every session's files. ("upld" in ASCII.) */
const UPLOAD_LOCK_KEY = 0x75706c64;

export interface NewUpload {
  id: string;
  sessionId: string;
  mime: FileMimeType;
  bytes: Buffer;
  originalName: string | null;
}

export type StoreResult = { ok: true; file: StoredFile } | { ok: false; reason: "tooManyFiles" | "budget" };

export async function storeUpload(pool: pg.Pool, upload: NewUpload, { budgetBytes }: { budgetBytes: number }): Promise<StoreResult> {
  return withTx(pool, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [UPLOAD_LOCK_KEY]);
    const { rows } = await tx.query<{ total: string; mine: number }>(
      "SELECT COALESCE(sum(size), 0)::text AS total, count(*) FILTER (WHERE session_id = $1)::int AS mine FROM files",
      [upload.sessionId],
    );
    const used = Number(rows[0]?.total ?? 0);
    if ((rows[0]?.mine ?? 0) >= MAX_FILES_PER_SESSION) return { ok: false, reason: "tooManyFiles" } as const;
    if (used + upload.bytes.length > budgetBytes) return { ok: false, reason: "budget" } as const;
    const file = await insertFile(tx, { id: upload.id, sessionId: upload.sessionId, mime: upload.mime, bytes: upload.bytes, originalName: upload.originalName });
    return { ok: true, file } as const;
  });
}

/** Metadata and bytes of one stored file, or null if there is none. */
export async function readStoredFile(pool: pg.Pool, fileId: string): Promise<{ file: StoredFile; bytes: Buffer } | null> {
  const file = await getFile(pool, fileId);
  if (!file) return null;
  const bytes = await getFileBytes(pool, fileId);
  return bytes ? { file, bytes } : null;
}

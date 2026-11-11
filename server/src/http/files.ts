// Uploads and signed downloads (P4-T03, D10, protocol.md §8).
// - POST /sessions/:sessionId/files: one multipart part named `file`, at most 10 MB. The type comes from the bytes
//   (magic numbers), never the name or the browser's claim. Stored with its SHA-256 in Postgres; the answer is an
//   opaque `file:<id>` ref that only this session's cards accept (P4-T02). Lazily creates the session, like a connect.
// - GET /files/:fileId?exp&sig: the bytes, only with a valid, unexpired HMAC signature (links appear only in records).
// Errors are `{ error: { code, message } }`. At most two uploads are read into memory at once per instance (each can
// hold up to 10 MB on a small free instance), one per client IP, and each must arrive within a deadline, so slow
// senders can't hold the slots; a client IP may also store only so many bytes an hour, so one address can't use up
// the global budget for everyone (P4 review #3, #4). Beyond any of these: 429, and the browser can retry.
import multipart from "@fastify/multipart";
import { parseSessionId } from "@device-repair/shared/protocol";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyReply } from "fastify";
import type pg from "pg";
import { MAX_FILE_BYTES } from "../domain/fields.js";
import { validateUpload } from "../domain/validators/files.js";
import type { FileUrlSigner } from "../files/signing.js";
import { readStoredFile, storeUpload } from "../files/storage.js";
import type { CreationLimiter } from "../session/creationLimit.js";
import { ensureSession, type NewSessionSettings } from "../session/ensureSession.js";
import { newFileId } from "../session/ids.js";

export interface FileRoutesOptions {
  pool: pg.Pool;
  signer: FileUrlSigner;
  /** UPLOAD_BUDGET_BYTES: the sum of all stored files may not exceed this (507 beyond it). */
  budgetBytes: number;
  sessionLimiter: CreationLimiter;
  newSession?: NewSessionSettings;
  /** Uploads read at the same time on this instance (default 2). */
  maxConcurrentUploads?: number;
  /** Upload requests per client IP per minute (default 30). */
  uploadsPerMinute?: number;
  /** Download requests per client IP per minute (default 120). */
  downloadsPerMinute?: number;
  /** Bytes one client IP may store per hour (default 100 MB: an invoice and five photos at the 10 MB limit is 60 MB). */
  uploadBytesPerIpPerHour?: number;
  /** The whole upload must arrive within this long (default 60 s); then the request is dropped. */
  uploadDeadlineMs?: number;
  now?: () => Date;
}

export type UploadErrorCode = "bad_request" | "session_closed" | "too_large" | "unsupported_type" | "rate_limited" | "storage_budget" | "internal_error";

const fail = (reply: FastifyReply, status: number, code: UploadErrorCode | "forbidden" | "expired" | "not_found", message: string) =>
  reply.code(status).header("cache-control", "no-store").send({ error: { code, message } });

/** A Content-Disposition that can't break out of its header: an ASCII fallback plus the RFC 5987 UTF-8 name. */
export function attachmentHeader(name: string | null, fileId: string): string {
  const base = name ?? fileId;
  const ascii = base.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`;
}

export async function fileRoutes(app: FastifyInstance, options: FileRoutesOptions): Promise<void> {
  const { pool, signer, budgetBytes, sessionLimiter } = options;
  const now = options.now ?? (() => new Date());
  const maxConcurrent = options.maxConcurrentUploads ?? 2;
  const deadlineMs = options.uploadDeadlineMs ?? 60_000;
  const quota = new ByteQuota(options.uploadBytesPerIpPerHour ?? 100 * 1024 * 1024, 60 * 60 * 1000);
  let uploading = 0;
  const uploadingByIp = new Map<string, number>();

  await app.register(async (scope) => {
    // Per route (global: false): uploads and downloads have separate budgets.
    await scope.register(rateLimit, {
      global: false,
      keyGenerator: (request) => request.ip,
      onExceeded: (request) => request.log.warn({ route: request.routeOptions.url }, "rate limit exceeded"),
      errorResponseBuilder: (_request, context) => ({
        statusCode: 429,
        code: "rate_limited",
        message: `Too many uploads; try again in ${Math.ceil(context.ttl / 1000)} s.`,
      }),
    });
    // This scope's errors keep protocol.md §8's shape; server errors never expose internals.
    scope.setErrorHandler((error: { statusCode?: number; code?: string; message: string }, request, reply) => {
      const status = error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
      if (status >= 500) {
        request.log.error({ code: error.code, message: error.message }, "file request failed");
        return fail(reply, 500, "internal_error", "Something went wrong. Please try again.");
      }
      return fail(reply, status, status === 429 ? "rate_limited" : "bad_request", error.message);
    });
    // One file part and nothing else; busboy stops reading past 10 MB (toBuffer then throws 413).
    await scope.register(multipart, { limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 0, parts: 1, headerPairs: 50 } });

    const perMinute = (max: number) => ({ rateLimit: { max, timeWindow: 60_000 } });

    scope.post("/sessions/:sessionId/files", { config: perMinute(options.uploadsPerMinute ?? 30) }, async (request, reply) => {
      const sessionId = parseSessionId((request.params as { sessionId?: unknown }).sessionId);
      if (!sessionId) return fail(reply, 400, "bad_request", "The session id must be a UUIDv4.");
      if (!request.isMultipart()) return fail(reply, 400, "bad_request", "Send the file as multipart/form-data with one part named file.");
      const ip = request.ip;
      if (uploading >= maxConcurrent || (uploadingByIp.get(ip) ?? 0) >= 1) {
        request.log.warn({ uploading, maxConcurrent }, "upload refused: too many at once");
        return fail(reply, 429, "rate_limited", "Too many uploads at once. Please try again in a moment.");
      }
      uploading += 1;
      uploadingByIp.set(ip, (uploadingByIp.get(ip) ?? 0) + 1);
      let timedOut = false;
      const deadline = setTimeout(() => {
        timedOut = true;
        request.raw.destroy(new Error("upload deadline passed"));
      }, deadlineMs);
      try {
        const created = await ensureSession(pool, sessionId, { via: "upload", limit: { limiter: sessionLimiter, key: request.ip }, newSession: options.newSession });
        if (!created.ok) {
          request.log.warn("upload refused: new-session rate limit");
          return fail(reply, 429, "rate_limited", "Too many new claims from this network. Please try again later.");
        }
        if (created.session.status === "closed") return fail(reply, 410, "session_closed", "This claim is closed.");

        let part: Awaited<ReturnType<typeof request.file>>;
        let bytes: Buffer;
        try {
          part = await request.file();
          if (part?.fieldname !== "file") return fail(reply, 400, "bad_request", "The upload needs one part named file.");
          bytes = await part.toBuffer();
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code === "FST_REQ_FILE_TOO_LARGE") return fail(reply, 413, "too_large", "That file is larger than 10 MB.");
          if (code === "FST_FILES_LIMIT" || code === "FST_PARTS_LIMIT" || code === "FST_FIELDS_LIMIT") {
            return fail(reply, 400, "bad_request", "Upload one file at a time.");
          }
          if (code === "FST_INVALID_MULTIPART_CONTENT_TYPE") return fail(reply, 400, "bad_request", "Send the file as multipart/form-data.");
          if (timedOut) {
            request.log.warn({ deadlineMs }, "upload dropped: too slow");
            return fail(reply, 408, "bad_request", "The upload took too long. Please try again.");
          }
          throw err;
        } finally {
          clearTimeout(deadline);
        }

        const checked = validateUpload("purchaseInvoice", { bytes, declaredType: part.mimetype, name: part.filename });
        if (checked.status !== "valid") {
          const message = checked.status === "invalid" ? checked.error : "That file couldn't be read.";
          if (bytes.length === 0) return fail(reply, 400, "bad_request", message);
          if (bytes.length > MAX_FILE_BYTES) return fail(reply, 413, "too_large", message);
          return fail(reply, 415, "unsupported_type", message);
        }

        if (!quota.tryUse(ip, bytes.length)) {
          request.log.warn({ size: bytes.length }, "upload refused: per-IP hourly byte quota");
          return fail(reply, 429, "rate_limited", "You've uploaded a lot in the last hour. Please try again later.");
        }
        const stored = await storeUpload(
          pool,
          { id: newFileId(), sessionId, mime: checked.normalized.mime, bytes, originalName: checked.normalized.originalName },
          { budgetBytes },
        );
        if (!stored.ok) {
          quota.giveBack(ip, bytes.length);
          if (stored.reason === "tooManyFiles") return fail(reply, 413, "too_large", "This claim already has the most files it can hold (12).");
          request.log.error({ budgetBytes }, "upload refused: the global upload budget is used up");
          return fail(reply, 507, "storage_budget", "Uploads are unavailable right now. Please try again later.");
        }
        request.log.info({ sessionId, fileId: stored.file.id, mime: stored.file.mime, size: stored.file.size }, "file stored");
        return reply.header("cache-control", "no-store").send({ url: `file:${stored.file.id}` });
      } finally {
        clearTimeout(deadline);
        uploading -= 1;
        const left = (uploadingByIp.get(ip) ?? 1) - 1;
        if (left > 0) uploadingByIp.set(ip, left);
        else uploadingByIp.delete(ip);
      }
    });

    scope.get("/files/:fileId", { config: perMinute(options.downloadsPerMinute ?? 120) }, async (request, reply) => {
      const fileId = (request.params as { fileId: string }).fileId;
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(fileId)) return fail(reply, 404, "not_found", "No such file.");
      const query = request.query as Record<string, unknown>;
      const check = signer.check(fileId, query.exp, query.sig, now());
      if (check === "badSignature") return fail(reply, 403, "forbidden", "This link isn't valid.");
      if (check === "expired") return fail(reply, 410, "expired", "This link has expired.");
      const found = await readStoredFile(pool, fileId);
      if (!found) return fail(reply, 404, "not_found", "No such file.");
      return reply
        .header("content-type", found.file.mime)
        .header("content-length", String(found.bytes.length))
        .header("content-disposition", attachmentHeader(found.file.originalName, fileId))
        .header("x-content-type-options", "nosniff")
        .header("cache-control", "private, no-store")
        .send(found.bytes);
    });
  });
}

/** Bytes per key per fixed window, in memory (per instance; enough to stop one address filling the budget). */
export class ByteQuota {
  readonly #used = new Map<string, { since: number; bytes: number }>();

  constructor(
    readonly maxBytes: number,
    readonly windowMs: number,
    readonly now: () => number = Date.now,
  ) {}

  tryUse(key: string, bytes: number): boolean {
    const now = this.now();
    for (const [k, entry] of this.#used) if (now - entry.since >= this.windowMs) this.#used.delete(k);
    const entry = this.#used.get(key) ?? { since: now, bytes: 0 };
    if (entry.bytes + bytes > this.maxBytes) return false;
    entry.bytes += bytes;
    this.#used.set(key, entry);
    return true;
  }

  /** Returns bytes that weren't stored after all. */
  giveBack(key: string, bytes: number): void {
    const entry = this.#used.get(key);
    if (entry) entry.bytes = Math.max(0, entry.bytes - bytes);
  }
}

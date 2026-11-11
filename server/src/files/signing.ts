// Signed, expiring file URLs (D10, P4-T03): `GET /files/:fileId?exp=<unix seconds>&sig=<HMAC>`. Records carry these,
// so a consumer can fetch the invoice and photos without a session. The signature covers the file id and the expiry,
// so neither can be changed; FILE_URL_SECRET never leaves the server.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Secret } from "../config.js";

/** Default lifetime of a signed link (protocol.md §8): 30 days. */
export const DEFAULT_FILE_URL_TTL_SECONDS = 30 * 24 * 60 * 60;

export type FileUrlCheck = "ok" | "badSignature" | "expired";

export interface FileUrlSigner {
  /** An absolute download URL for the file, valid for the configured lifetime from `now`. */
  sign(fileId: string, now: Date): string;
  /** Checks a request's `exp` and `sig` (as received, unparsed). A bad signature is reported before expiry. */
  check(fileId: string, exp: unknown, sig: unknown, now: Date): FileUrlCheck;
}

export function createFileUrlSigner(options: { secret: Secret; publicOrigin: string; ttlSeconds?: number }): FileUrlSigner {
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_FILE_URL_TTL_SECONDS;
  const mac = (fileId: string, exp: string) => createHmac("sha256", options.secret.reveal()).update(`${fileId}.${exp}`).digest();
  return {
    sign(fileId, now) {
      const exp = String(Math.floor(now.getTime() / 1000) + ttlSeconds);
      const sig = mac(fileId, exp).toString("base64url");
      return `${options.publicOrigin}/files/${encodeURIComponent(fileId)}?exp=${exp}&sig=${sig}`;
    },
    check(fileId, exp, sig, now) {
      if (typeof exp !== "string" || !/^\d{1,12}$/.test(exp) || typeof sig !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return "badSignature";
      const expected = mac(fileId, exp);
      const given = Buffer.from(sig, "base64url");
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return "badSignature";
      return Number(exp) * 1000 < now.getTime() ? "expired" : "ok";
    },
  };
}

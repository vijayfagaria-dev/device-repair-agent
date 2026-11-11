// The stub record receiver (P7-T04, D17): the default RECORD_WEBHOOK_URL target, which shows idempotent delivery end
// to end. A key is stored once; every repeat is a 200 that only bumps a counter.
//   POST /hooks/records  needs `X-Hook-Secret` (constant-time compare) and an `Idempotency-Key` (`<sessionId>:<revision>`)
//                        that matches the body, a record valid against the published schema.
//   GET  /hooks/records  lists what was received; only with the test token, and only when the test API is on.
import { createHash, timingSafeEqual } from "node:crypto";
import { parseSessionId } from "@device-repair/shared/protocol";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { Secret } from "../config.js";
import { listReceivedRecords, upsertReceivedRecord } from "../db/repos/receivedRecords.js";
import type { JsonValue } from "../db/repos/rows.js";
import { RecordSchemaError, validateRecord } from "../domain/record.js";
import { hasBearerToken } from "./sessions.js";

export interface HookRoutesOptions {
  pool: pg.Pool;
  hookSecret: Secret;
  /** Set only when ALLOW_TEST_API=true: enables the token-gated GET. */
  testApiToken?: Secret | null;
}

/** A record is at most a few KB; this is a generous cap on what the stub reads. */
const MAX_BODY_BYTES = 256 * 1024;
const KEY = /^([^:]+):([1-9]\d{0,5})$/;

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Constant-time comparison (hashing first makes it independent of the lengths). */
export function secretMatches(header: unknown, secret: Secret): boolean {
  return typeof header === "string" && timingSafeEqual(digest(header), digest(secret.reveal()));
}

export async function hookRoutes(app: FastifyInstance, { pool, hookSecret, testApiToken }: HookRoutesOptions): Promise<void> {
  app.post(
    "/hooks/records",
    {
      bodyLimit: MAX_BODY_BYTES,
      // Before the body is read: an unauthenticated caller costs a header check, nothing more.
      onRequest: async (request, reply) => {
        reply.header("cache-control", "no-store");
        if (!secretMatches(request.headers["x-hook-secret"], hookSecret)) {
          return reply.code(401).send({ error: "unauthorized" });
        }
      },
    },
    async (request, reply) => {
      const header = request.headers["idempotency-key"];
      const match = typeof header === "string" ? KEY.exec(header) : null;
      const sessionId = match?.[1] ? parseSessionId(match[1]) : null;
      if (!match || !sessionId) return reply.code(400).send({ error: "invalid_idempotency_key", message: "Idempotency-Key must be <sessionId>:<revision>." });
      const body = request.body;
      try {
        validateRecord(body);
      } catch (err) {
        if (!(err instanceof RecordSchemaError)) throw err;
        // Paths and keywords only, never the values.
        return reply.code(400).send({ error: "invalid_record", problems: err.problems.map((p) => ({ path: p.path, keyword: p.keyword })) });
      }
      if (body.sessionId !== sessionId || String(body.revision) !== match[2]) {
        return reply.code(400).send({ error: "key_mismatch", message: "The Idempotency-Key doesn't match the record's sessionId and revision." });
      }
      const stored = await upsertReceivedRecord(pool, { idempotencyKey: header as string, payload: body as unknown as JsonValue });
      request.log.info({ idempotencyKey: stored.idempotencyKey, timesReceived: stored.timesReceived }, "record received");
      return { stored: true, timesReceived: stored.timesReceived };
    },
  );

  if (testApiToken) {
    app.get("/hooks/records", async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (!hasBearerToken(request.headers.authorization, testApiToken)) return reply.code(401).send({ error: "unauthorized" });
      const received = await listReceivedRecords(pool);
      return {
        records: received.map((r) => ({
          idempotencyKey: r.idempotencyKey,
          timesReceived: r.timesReceived,
          firstReceivedAt: r.firstReceivedAt.toISOString(),
          lastReceivedAt: r.lastReceivedAt.toISOString(),
          record: r.payload,
        })),
      };
    });
  }
}

// Session HTTP API (P3-T02; D07, D19).
// - GET /api/sessions/:id, /timeline, /records: read-only views for debugging and the test harness. The session id is
//   the capability (protocol.md §2): whoever holds the link sees the session, including what the user entered.
//   Reading never creates a session and is never user activity. Rate-limited per client IP.
// - POST /api/sessions: test-only session creation, registered only when ALLOW_TEST_API=true and requiring
//   `Authorization: Bearer <TEST_API_TOKEN>`. The UI never calls it; browsers create sessions lazily.
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { RECORD_FIELD_IDS } from "@device-repair/shared/fields";
import { parseSessionId } from "@device-repair/shared/protocol";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type { Secret } from "../config.js";
import { listEvents } from "../db/repos/events.js";
import { listOutbox } from "../db/repos/outbox.js";
import { listFieldCandidates } from "../db/repos/fieldCandidates.js";
import { getOpenInputRequest } from "../db/repos/inputRequests.js";
import { listRecords } from "../db/repos/records.js";
import { getSession, type Session } from "../db/repos/sessions.js";
import { listTimers } from "../db/repos/timers.js";
import { listTranscriptLines } from "../db/repos/transcriptLines.js";
import { listTurnMetrics } from "../db/repos/turnMetrics.js";
import { listUsage } from "../db/repos/usage.js";
import { missingRequired } from "../domain/outcome.js";
import { projectValue } from "../domain/record.js";
import { sessionCost } from "../metrics/usage.js";
import type { Command, CommandProcessor } from "../session/commands.js";
import { SessionNotFoundError } from "../session/commands.js";
import { ensureSession, type NewSessionSettings } from "../session/ensureSession.js";
import type { FinalizeReply } from "../session/handlers/finalize.js";
import { resolveFields } from "../session/snapshot.js";

// ---------------------------------------------------------------------------------------------------------------------
// Test-only creation

export interface SessionRoutesOptions {
  pool: pg.Pool;
  testApiToken: Secret;
  newSession?: NewSessionSettings;
  /** Runs the Finalize command for the test-only finalize route (P7-T01). */
  processor: CommandProcessor;
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Constant-time check of a `Bearer` header (hashing first makes the comparison length-independent). */
export function hasBearerToken(header: string | undefined, token: Secret): boolean {
  const match = /^Bearer (.+)$/.exec(header ?? "");
  if (!match?.[1]) return false;
  return timingSafeEqual(digest(match[1]), digest(token.reveal()));
}

export async function testSessionRoutes(app: FastifyInstance, { pool, testApiToken, newSession, processor }: SessionRoutesOptions): Promise<void> {
  app.post("/api/sessions", async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!hasBearerToken(request.headers.authorization, testApiToken)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const id = randomUUID();
    const result = await ensureSession(pool, id, { via: "testApi", newSession });
    if (!result.ok || !result.created) throw new Error("test API could not create a fresh session");
    request.log.info({ sessionId: id, via: "testApi" }, "session created");
    return reply.code(201).send({ sessionId: id });
  });

  /**
   * Finalizes a session with the `testFinalize` trigger (D16): for tests and demos only. It is a trigger like any
   * other, so the usual rules apply (an active session only; an unchanged claim gives no new revision).
   */
  app.post("/api/sessions/:id/finalize", async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!hasBearerToken(request.headers.authorization, testApiToken)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const id = parseSessionId((request.params as { id?: unknown }).id);
    if (!id) return reply.code(400).send({ error: "invalid_session_id", message: "The session id must be a UUIDv4." });
    try {
      const { reply: result } = await processor.dispatch<FinalizeReply>(id, { type: "Finalize", trigger: "testFinalize" } as Command);
      return result ?? { finalized: false, reason: "nothing to do" };
    } catch (err) {
      if (err instanceof SessionNotFoundError) return reply.code(404).send({ error: "not_found", message: "No such session." });
      throw err;
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Read API

export interface SessionReadOptions {
  pool: pg.Pool;
  /** Requests per client IP per minute across the read routes (default 60). */
  perMinute?: number;
}

/**
 * Keys that must never appear in a response, at any depth: secrets and credentials (`…token`, but not counts such as
 * `promptTokens`), internal paths and storage keys (`…path`, `storageKey`), provider-side ids (`provider…Id`), and the
 * LLM's evidence quote. A deny-list, because event payloads are open-ended (D12).
 */
const HIDDEN_KEY = /(secret|token$|password|passwd|api_?key|authorization|cookie|path$|storage_?key|^evidence$|^provider\w*id$)/i;

/**
 * A deep copy without hidden keys, and with upload refs (`file:<fileId>`, protocol.md §8) reduced to the bare file id:
 * the ref is the wire form between the page and the server, not something an API consumer should see or build on.
 * Event payloads are open-ended, so the timeline filters them on the way out.
 */
export function withoutHiddenKeys(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/^file:(?=[A-Za-z0-9])/, "");
  if (Array.isArray(value)) return value.map(withoutHiddenKeys);
  if (typeof value === "object" && value !== null && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !HIDDEN_KEY.test(key))
        .map(([key, item]) => [key, withoutHiddenKeys(item)]),
    );
  }
  return value;
}

/** File values without a URL: signed links belong only in records (protocol.md §8). */
const UNSIGNED = () => "";
function displayValue(field: (typeof RECORD_FIELD_IDS)[number], value: unknown): unknown {
  const projected = projectValue(field, value, UNSIGNED);
  const strip = (item: unknown) => {
    if (typeof item !== "object" || item === null) return item;
    const { url: _url, ...rest } = item as Record<string, unknown>;
    return rest;
  };
  if (field === "purchaseInvoice") return strip(projected);
  if (field === "additionalPhotos" && Array.isArray(projected)) return projected.map(strip);
  return projected;
}

async function loadSession(pool: pg.Pool, request: FastifyRequest, reply: FastifyReply): Promise<Session | null> {
  reply.header("cache-control", "no-store");
  const id = parseSessionId((request.params as { id?: unknown }).id);
  if (!id) {
    await reply.code(400).send({ error: "invalid_session_id", message: "The session id must be a UUIDv4." });
    return null;
  }
  const session = await getSession(pool, id);
  if (!session) {
    await reply.code(404).send({ error: "not_found", message: "No such session." });
    return null;
  }
  return session;
}

export async function sessionReadRoutes(app: FastifyInstance, { pool, perMinute = 60 }: SessionReadOptions): Promise<void> {
  await app.register(async (api) => {
    await api.register(rateLimit, {
      max: perMinute,
      timeWindow: 60_000,
      // request.ip honours TRUST_PROXY_HOPS (app.ts), so clients behind Render's proxy aren't one shared key.
      keyGenerator: (request) => request.ip,
      onExceeded: (request) => request.log.warn({ route: request.routeOptions.url }, "rate limit exceeded"),
      errorResponseBuilder: (_request, context) => ({
        statusCode: 429,
        code: "rate_limited",
        message: `Too many requests; try again in ${Math.ceil(context.ttl / 1000)} s.`,
      }),
    });

    /** The session's current state, with every field's effective value computed by the resolver (P2-T05). */
    api.get("/api/sessions/:id", async (request, reply) => {
      const session = await loadSession(pool, request, reply);
      if (!session) return reply;
      const [candidates, timers, open] = await Promise.all([
        listFieldCandidates(pool, session.id),
        listTimers(pool, session.id),
        getOpenInputRequest(pool, session.id),
      ]);
      const resolved = resolveFields(candidates);
      const fields = Object.fromEntries(
        RECORD_FIELD_IDS.map((id) => {
          const field = resolved[id];
          return [id, { value: displayValue(id, field.value), source: field.source, collectedAt: field.collectedAt, status: field.status }];
        }),
      );
      const conflicts = RECORD_FIELD_IDS.flatMap((id) => {
        const conflict = resolved[id].conflict;
        if (!conflict) return [];
        return [{ ...conflict, callValue: displayValue(id, conflict.callValue), chatValue: displayValue(id, conflict.chatValue) }];
      });
      return {
        sessionId: session.id,
        status: session.status,
        outcome: session.outcome,
        revision: session.currentRevision > 0 ? session.currentRevision : null,
        version: session.version,
        callActive: session.activeCallId !== null,
        openRequest: open ? { id: open.id, field: open.field } : null,
        fields,
        missingRequired: missingRequired(resolved),
        conflicts,
        timers: timers.map((timer) => ({ kind: timer.kind, dueAt: timer.dueAt.toISOString() })),
        createdAt: session.createdAt.toISOString(),
        lastActivityAt: session.lastActivityAt.toISOString(),
      };
    });

    /** Events, transcript, turn timings and cost (D19): the debugging timeline. */
    api.get("/api/sessions/:id/timeline", async (request, reply) => {
      const session = await loadSession(pool, request, reply);
      if (!session) return reply;
      const [events, transcript, turns, usage, cost, outbox] = await Promise.all([
        listEvents(pool, session.id),
        listTranscriptLines(pool, session.id),
        listTurnMetrics(pool, session.id),
        listUsage(pool, session.id),
        sessionCost(pool, session.id),
        listOutbox(pool, session.id),
      ]);
      return {
        sessionId: session.id,
        events: events.map((event) => ({
          seq: event.seq,
          type: event.type,
          channel: event.channel,
          at: event.createdAt.toISOString(),
          payload: withoutHiddenKeys(event.payload),
        })),
        transcript: transcript.map((line) => ({
          id: line.id,
          callId: line.callId,
          role: line.role,
          text: line.text,
          interrupted: line.interrupted,
          startedAt: line.startedAt.toISOString(),
        })),
        turns: turns.map((turn) => withoutHiddenKeys(turn)),
        usage: usage.map((entry) => ({
          provider: entry.provider,
          kind: entry.kind,
          units: entry.units,
          unit: entry.unit,
          costUsd: entry.costUsd,
          at: entry.at.toISOString(),
        })),
        cost,
        // Delivery of each record revision (P7-T03): a dead one shows here with its last error.
        deliveries: outbox.map((entry) => ({
          revision: entry.revision,
          target: entry.target,
          status: entry.status,
          attempts: entry.attempts,
          nextAttemptAt: entry.status === "delivered" || entry.status === "dead" ? null : entry.nextAttemptAt.toISOString(),
          lastError: entry.lastError,
          deliveredAt: entry.deliveredAt?.toISOString() ?? null,
        })),
      };
    });

    /** Every record revision, oldest first (immutable, D17). */
    api.get("/api/sessions/:id/records", async (request, reply) => {
      const session = await loadSession(pool, request, reply);
      if (!session) return reply;
      const records = await listRecords(pool, session.id);
      return {
        sessionId: session.id,
        records: records.map((record) => ({
          revision: record.revision,
          outcome: record.outcome,
          contentHash: record.contentHash,
          createdAt: record.createdAt.toISOString(),
          record: record.payload,
        })),
      };
    });
  });
}

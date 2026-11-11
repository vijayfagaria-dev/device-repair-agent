// Session services for tests, with test-only command handlers that produce what later phases' handlers will (chat
// messages, transcript lines, cards, calls, user activity). Production code never registers these.
import { Role } from "@device-repair/shared/protocol";
import { Secret } from "../../src/config.js";
import type { Database } from "../../src/db/pool.js";
import { endCall, insertCall } from "../../src/db/repos/calls.js";
import type { JsonObject } from "../../src/db/repos/rows.js";
import { FIELDS } from "../../src/domain/fields.js";
import { createFileUrlSigner } from "../../src/files/signing.js";
import { createLogger } from "../../src/log.js";
import type { Command, Effects, Handler, TimerSettings } from "../../src/session/commands.js";
import { createSessionServices, type SessionServices, type SessionServicesOptions } from "../../src/session/services.js";
import { FAKE } from "../fixtures.js";

export const TEST_TIMERS: TimerSettings = { idleTimeoutMs: 15 * 60_000, sessionLifetimeMs: 7 * 24 * 60 * 60_000 };

/** The file-link signer tests use (a fake secret; the origin is the test app's). */
export const TEST_FILE_URL_SECRET = new Secret(FAKE.FILE_URL_SECRET);
export const TEST_SIGNER = createFileUrlSigner({ secret: TEST_FILE_URL_SECRET, publicOrigin: "https://repair.example.com" });

type Cmd<T extends string, P = object> = { type: T } & P;

const handlers: Record<string, Handler<Command & Record<string, unknown>>> = {
  /** One plain event; `n` lands in the payload. */
  "Test.Append": (_s, c) => ({ events: [{ type: "test.event", channel: "system", payload: { n: c.n as number } }] }),
  /** An agent (or user) chat message. */
  "Test.Say": (_s, c) => ({
    events: [
      {
        type: "chat.message",
        channel: "chat",
        chatMessage: { id: c.messageId as string, role: (c.role as Role) ?? Role.AGENT, text: c.text as string, requestId: (c.requestId as string) ?? null },
      },
    ],
  }),
  /** A final call transcript line (the call row must exist). */
  "Test.Transcript": (s, c) => ({
    events: [
      {
        type: "transcript.final",
        channel: "call",
        transcriptLine: { id: c.lineId as string, callId: c.callId as string, role: (c.role as Role) ?? Role.USER, text: c.text as string, startedAt: s.now },
      },
    ],
  }),
  /** Opens the catalog card for `field` as `requestId`. */
  "Test.OpenCard": (_s, c) => {
    const field = c.field as keyof typeof FIELDS;
    return {
      events: [
        {
          type: "input.requested",
          channel: "chat",
          inputRequest: { id: c.requestId as string, field, spec: FIELDS[field].card as unknown as JsonObject, status: "open" },
        },
      ],
    };
  },
  "Test.CancelCard": (_s, c) => ({
    events: [
      {
        type: "input.cancelled",
        channel: "chat",
        payload: { requestId: c.requestId as string, reason: "test" },
        inputRequestUpdate: { id: c.requestId as string, status: "cancelled" },
      },
    ],
  }),
  /** An invalid answer to an open card: the card stays open with one more attempt (what P4-T02 will record). */
  "Test.Reject": (s, c) => {
    const request = s.requests.find((r) => r.id === c.requestId);
    const attempt = (request?.attempts ?? 0) + 1;
    return {
      events: [
        {
          type: "input.rejected",
          channel: "chat",
          payload: { requestId: c.requestId as string, attempt, message: "That doesn't look right." },
          inputRequestUpdate: { id: c.requestId as string, status: "open", attempts: attempt },
        },
      ],
    };
  },
  /** Explicit user activity (moves the idle and expiry timers). */
  "Test.Activity": () => ({ activity: true, events: [{ type: "test.activity", channel: "chat" }] }),
  "Test.StartCall": (_s, c) => ({ session: { activeCallId: c.callId as string }, events: [{ type: "call.started", channel: "call" }] }),
  "Test.EndCall": () => ({ session: { activeCallId: null }, events: [{ type: "call.ended", channel: "call" }] }),
  /** A candidate for `field` (raw value as given, validated elsewhere). */
  "Test.Candidate": (_s, c) => ({
    events: [
      {
        type: "field.candidate",
        channel: (c.source as "call" | "chat") ?? "chat",
        candidate: {
          field: c.field as string,
          source: ((c.source as string) ?? "chat") as never,
          raw: c.raw as never,
          normalized: (c.normalized ?? null) as never,
          status: (c.status as never) ?? "valid",
          evidence: (c.evidence as string) ?? null,
        },
      },
    ],
  }),
  "Test.Throw": () => {
    throw new Error("handler failed on purpose");
  },
  "Test.ThrowAfterWrite": () => ({
    // Two events, the second invalid (channel violates the CHECK): the first must roll back with it.
    events: [
      { type: "test.event", channel: "system" },
      { type: "test.event", channel: "bogus" as never },
    ],
  }),
  "Test.Noop": () => ({ reply: "nothing to do" }) satisfies Effects<string>,
};

/**
 * Services with the test-only handlers. The chat planner is off unless asked for: transport tests script their own
 * cards, which the planner would otherwise join (P4 tests turn it on).
 */
export function testServices(
  db: Database,
  options: { now?: () => Date; timers?: TimerSettings } & Partial<Pick<SessionServicesOptions, "planner" | "signFileUrl" | "log" | "failpoint" | "autoCompleteOnIdle" | "onOutboxQueued">> = {},
): SessionServices {
  const services = createSessionServices({
    pool: db.pool,
    log: options.log ?? createLogger("silent"),
    timers: options.timers ?? TEST_TIMERS,
    now: options.now,
    planner: options.planner ?? false,
    signFileUrl: options.signFileUrl ?? TEST_SIGNER.sign,
    failpoint: options.failpoint,
    autoCompleteOnIdle: options.autoCompleteOnIdle,
    onOutboxQueued: options.onOutboxQueued,
  });
  for (const [type, handler] of Object.entries(handlers)) services.processor.register(type, handler);
  return services;
}

export type TestCommand =
  | Cmd<"Test.Append", { n: number }>
  | Cmd<"Test.Say", { messageId: string; text: string; role?: Role; requestId?: string }>
  | Cmd<"Test.Transcript", { lineId: string; callId: string; text: string; role?: Role }>
  | Cmd<"Test.OpenCard", { requestId: string; field: string }>
  | Cmd<"Test.CancelCard", { requestId: string }>
  | Cmd<"Test.Activity">
  | Cmd<"Test.StartCall", { callId: string }>
  | Cmd<"Test.EndCall">;

/** A call row, so transcript lines can refer to it. */
export async function seedCall(db: Database, sessionId: string, callId: string, startedAt?: Date): Promise<void> {
  await insertCall(db.pool, { id: callId, sessionId, startedAt });
}

/** Ends the call row (what P5's EndCall will write); then dispatch Test.EndCall for the session side. */
export async function endSeededCall(db: Database, callId: string, endedAt?: Date): Promise<void> {
  await endCall(db.pool, { id: callId, reason: "test", endedAt });
}

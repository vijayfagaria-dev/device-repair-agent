// The session services one server process shares: the hub (live fan-out) and the command processor (the single
// writer), with every command handler and the post-commit reactions. Later phases register theirs here (P5 call
// commands, P7 outcome triggers).
import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";
import { withoutFileUrls } from "../domain/record.js";
import { CommandProcessor, type CommandProcessorOptions, type TimerSettings } from "./commands.js";
import {
  type AgentSays,
  agentSaysHandler,
  type AppendTranscript,
  appendTranscriptHandler,
  type EndCall,
  endCallHandler,
  type FlagForReview,
  flagForReviewHandler,
  type OptOutByCall,
  optOutByCallHandler,
  type SaveSpokenField,
  saveSpokenFieldHandler,
  type StartCall,
  startCallHandler,
} from "./handlers/call.js";
import type { OptOutRequested, SubmitChatInput } from "./handlers/chatInput.js";
import { type Finalize, type FinalizeDeps, finalizeHandler, finalizePrepare } from "./handlers/finalize.js";
import { optOutHandler } from "./handlers/optOut.js";
import { type Reconcile, type RequestInput, reconcileHandler, reconcileReaction, requestInputHandler } from "./handlers/requestInput.js";
import { submitChatInputHandler, submitChatInputPrepare } from "./handlers/submitChatInput.js";
import { type TimerFired, timerFiredHandler, timerFiredPrepare } from "./handlers/timers.js";
import { SessionHub } from "./hub.js";

export interface SessionServices {
  hub: SessionHub;
  processor: CommandProcessor;
}

export const DEFAULT_TIMER_SETTINGS: TimerSettings = {
  idleTimeoutMs: 15 * 60 * 1000, // PD3: 15 minutes
  sessionLifetimeMs: 7 * 24 * 60 * 60 * 1000, // PD3a: 7 days
};

/** Used when no signer is configured (tests that never finalize a file): a record with a file can't be built. */
const NO_FILE_URLS = (): string => {
  throw new Error("file URL signing is not configured");
};

export interface SessionServicesOptions {
  pool: pg.Pool;
  log: FastifyBaseLogger;
  timers?: TimerSettings;
  now?: () => Date;
  /** Signs the file links a record carries (FILE_URL_SECRET, files/signing.ts). */
  signFileUrl?: FinalizeDeps["signFileUrl"];
  /** AUTO_COMPLETE_ON_IDLE (D16), default true. */
  autoCompleteOnIdle?: boolean;
  /**
   * Runs the chat planner after every command (P4-T01). On in production; tests of the transport alone turn it off
   * so their scripted cards aren't joined by the planner's.
   */
  planner?: boolean;
  /** A crash point inside the command transaction, for tests (commands.ts); production never sets it. */
  failpoint?: CommandProcessorOptions["failpoint"];
  /** Told after a command committed a record, so the outbox worker delivers it at once (P7-T03). */
  onOutboxQueued?: () => void;
}

export function createSessionServices(options: SessionServicesOptions): SessionServices {
  const hub = new SessionHub(options.log);
  const processor = new CommandProcessor({ pool: options.pool, hub, log: options.log, timers: options.timers ?? DEFAULT_TIMER_SETTINGS,
    now: options.now,
    failpoint: options.failpoint,
    onOutboxQueued: options.onOutboxQueued,
  });
  const finalizeDeps: FinalizeDeps = { signFileUrl: options.signFileUrl ?? NO_FILE_URLS, autoCompleteOnIdle: options.autoCompleteOnIdle ?? true };

  processor.register<TimerFired, unknown>("TimerFired", timerFiredHandler(finalizeDeps), { prepare: timerFiredPrepare });
  processor.register<SubmitChatInput, unknown>("SubmitChatInput", submitChatInputHandler(finalizeDeps), { prepare: submitChatInputPrepare });
  processor.register<OptOutRequested, unknown>("OptOutRequested", optOutHandler);
  processor.register<Finalize, unknown>("Finalize", finalizeHandler(finalizeDeps), { prepare: finalizePrepare });
  processor.register<Reconcile, unknown>("Reconcile", reconcileHandler);
  processor.register<RequestInput, unknown>("RequestInput", requestInputHandler);
  // The call (P5): lifecycle, transcript and the agent's tools.
  processor.register<StartCall, unknown>("StartCall", startCallHandler);
  processor.register<EndCall, unknown>("EndCall", endCallHandler);
  processor.register<AppendTranscript, unknown>("AppendTranscript", appendTranscriptHandler);
  processor.register<AgentSays, unknown>("AgentSays", agentSaysHandler);
  processor.register<SaveSpokenField, unknown>("SaveSpokenField", saveSpokenFieldHandler);
  processor.register<FlagForReview, unknown>("FlagForReview", flagForReviewHandler);
  processor.register<OptOutByCall, unknown>("OptOutByCall", optOutByCallHandler(finalizeDeps), { prepare: finalizePrepare });

  // Delivery is just this log line until the outbox worker (P7-T03): the brief allows logging the record. Without the
  // signed file links: they are bearer URLs for 30 days, and logs are read more widely than records (P4 review #8).
  processor.addReaction((sessionId, update) => {
    if (!update?.record) return;
    const finalized = update.events.find((event) => event.type === "session.finalized");
    if (finalized?.payload.schemaProblems) {
      // R-5: a record that broke its own schema is a bug (D17); paths and keywords only, never values.
      options.log.error({ sessionId, revision: update.record.revision, problems: finalized.payload.schemaProblems }, "record failed its schema; finalized as needsReview");
    }
    options.log.info({ sessionId, revision: update.record.revision, record: withoutFileUrls(update.record.payload) }, "record produced");
  });
  if (options.planner ?? true) processor.addReaction(reconcileReaction(processor));
  return { hub, processor };
}

// Startup recovery (P8-T01, architecture §5.5): runs after the migrations and before the server listens, so nothing
// depends on in-memory state from before a crash and no client sees a half-recovered session. Every step is
// idempotent (a second run finds nothing to do) and logs how many things it fixed.
//
//  1. Dangling calls: a call with no end, or a session still pointing at a call, ends with `server_restart`; the chat
//     gets "The call was interrupted; let's continue here."
//  2. Outbox leases a dead process held go back to `pending`, due now.
//  3. Overdue timers fire (the sweeper starts and runs its first sweep to completion), then sleeps until the next one.
//  4. Every active session is reconciled: a card that should be open (for example right after a call ended) opens.
//  5. Orphaned uploads (older than a grace period, named by no answer) are deleted.
import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";
import { endCall, listActiveCallPointers, listOpenCalls } from "../db/repos/calls.js";
import { deleteOrphanFiles } from "../db/repos/files.js";
import { reclaimOutboxLeases } from "../db/repos/outbox.js";
import { countOverdueTimers } from "../db/repos/timers.js";
import type { Sweeper } from "../jobs/sweeper.js";
import type { CommandProcessor } from "../session/commands.js";
import type { EndCall, EndCallReply } from "../session/handlers/call.js";
import { reconcileActiveSessions } from "../session/handlers/requestInput.js";

/** An upload nobody has answered with after this long is an orphan (the page uploads and submits in one go). */
export const ORPHAN_UPLOAD_AGE_MS = 60 * 60 * 1000;

export interface RecoveryDeps {
  pool: pg.Pool;
  processor: CommandProcessor;
  sweeper: Pick<Sweeper, "start" | "sweep">;
  log: FastifyBaseLogger;
  now?: () => Date;
}

export interface RecoveryReport {
  danglingCalls: number;
  leasesReclaimed: number;
  overdueTimers: number;
  sessionsReconciled: number;
  orphanUploads: number;
}

/** Ends every call that was running when the previous process died. Returns how many it closed. */
export async function endDanglingCalls(deps: Pick<RecoveryDeps, "pool" | "processor" | "log">): Promise<number> {
  const { pool, processor, log } = deps;
  const targets = new Map<string, { sessionId: string; callId: string }>();
  for (const call of await listOpenCalls(pool)) targets.set(call.id, { sessionId: call.sessionId, callId: call.id });
  for (const pointer of await listActiveCallPointers(pool)) targets.set(pointer.callId, pointer);

  let closed = 0;
  for (const { sessionId, callId } of targets.values()) {
    try {
      const { reply } = await processor.dispatch<EndCallReply>(sessionId, { type: "EndCall", callId, reason: "server_restart" } as EndCall);
      if (reply?.status === "ended") {
        closed += 1;
        continue;
      }
      // The session doesn't point at this call (an inconsistency): still close the call row itself.
      if (await endCall(pool, { id: callId, reason: "server_restart" })) closed += 1;
    } catch (err) {
      log.error({ sessionId, callId, err }, "recovery: could not end a dangling call");
    }
  }
  return closed;
}

export async function recoverOnBoot(deps: RecoveryDeps): Promise<RecoveryReport> {
  const { pool, processor, sweeper, log } = deps;
  const now = deps.now ?? (() => new Date());

  const danglingCalls = await endDanglingCalls(deps);
  log.info({ count: danglingCalls }, "recovery: dangling calls ended");

  const leasesReclaimed = await reclaimOutboxLeases(pool);
  log.info({ count: leasesReclaimed }, "recovery: outbox leases reclaimed");

  const overdueTimers = await countOverdueTimers(pool);
  await sweeper.start();
  await sweeper.sweep();
  log.info({ count: overdueTimers }, "recovery: overdue timers fired");

  const sessionsReconciled = await reconcileActiveSessions(pool, processor, log);
  log.info({ count: sessionsReconciled }, "recovery: active sessions reconciled");

  const orphanUploads = await deleteOrphanFiles(pool, new Date(now().getTime() - ORPHAN_UPLOAD_AGE_MS));
  log.info({ count: orphanUploads }, "recovery: orphaned uploads deleted");

  return { danglingCalls, leasesReclaimed, overdueTimers, sessionsReconciled, orphanUploads };
}

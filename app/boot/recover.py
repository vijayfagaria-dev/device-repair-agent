"""Startup recovery (P8-T01, architecture section 5.5): runs after the migrations and before the server listens, so
nothing depends on in-memory state from before a crash and no client sees a half-recovered session. Every step is
idempotent (a second run finds nothing to do) and logs how many things it fixed.

 1. Dangling calls: a call with no end, or a session still pointing at a call, ends with `server_restart`; the chat gets
    "The call was interrupted; let's continue here."
 2. Outbox leases a dead process held go back to `pending`, due now.
 3. Overdue timers fire (the sweeper starts and runs its first sweep to completion), then sleeps until the next one.
 4. Every active session is reconciled: a card that should be open (for example right after a call ended) opens.
 5. Orphaned uploads (older than a grace period, named by no answer) are deleted.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from app.db.repos.calls import end_call, list_active_call_pointers, list_open_calls
from app.db.repos.files import delete_orphan_files
from app.db.repos.outbox import reclaim_outbox_leases
from app.db.repos.timers import count_overdue_timers
from app.session.commands import CommandProcessor
from app.session.handlers.call import EndCall
from app.session.handlers.request_input import reconcile_active_sessions

#: An upload nobody has answered with after this long is an orphan (the page uploads and submits in one go).
ORPHAN_UPLOAD_AGE_MS = 60 * 60 * 1000


class SweeperLike(Protocol):
    async def start(self) -> None: ...
    async def sweep(self) -> None: ...


@dataclass(frozen=True, slots=True)
class RecoveryReport:
    dangling_calls: int
    leases_reclaimed: int
    overdue_timers: int
    sessions_reconciled: int
    orphan_uploads: int


async def end_dangling_calls(*, pool: Any, processor: CommandProcessor, log: Any) -> int:
    """Ends every call that was running when the previous process died. Returns how many it closed."""
    targets: dict[str, tuple[str, str]] = {}
    for call in await list_open_calls(pool):
        targets[call.id] = (call.session_id, call.id)
    for pointer in await list_active_call_pointers(pool):
        targets[pointer.call_id] = (pointer.session_id, pointer.call_id)

    closed = 0
    for session_id, call_id in targets.values():
        try:
            result = await processor.dispatch(session_id, EndCall(call_id=call_id, reason="server_restart"))
            if result.reply and result.reply.get("status") == "ended":
                closed += 1
                continue
            # The session doesn't point at this call (an inconsistency): still close the call row itself.
            if await end_call(pool, id=call_id, reason="server_restart"):
                closed += 1
        except Exception as err:
            log.error("recovery: could not end a dangling call", session_id=session_id, call_id=call_id, err=repr(err))
    return closed


async def recover_on_boot(
    *,
    pool: Any,
    processor: CommandProcessor,
    sweeper: SweeperLike,
    log: Any,
    now: Callable[[], datetime] | None = None,
) -> RecoveryReport:
    clock = now or (lambda: datetime.now(UTC))

    dangling_calls = await end_dangling_calls(pool=pool, processor=processor, log=log)
    log.info("recovery: dangling calls ended", count=dangling_calls)

    leases_reclaimed = await reclaim_outbox_leases(pool)
    log.info("recovery: outbox leases reclaimed", count=leases_reclaimed)

    overdue_timers = await count_overdue_timers(pool)
    await sweeper.start()
    await sweeper.sweep()
    log.info("recovery: overdue timers fired", count=overdue_timers)

    sessions_reconciled = await reconcile_active_sessions(pool, processor, log)
    log.info("recovery: active sessions reconciled", count=sessions_reconciled)

    orphan_uploads = await delete_orphan_files(pool, clock() - timedelta(milliseconds=ORPHAN_UPLOAD_AGE_MS))
    log.info("recovery: orphaned uploads deleted", count=orphan_uploads)

    return RecoveryReport(dangling_calls, leases_reclaimed, overdue_timers, sessions_reconciled, orphan_uploads)

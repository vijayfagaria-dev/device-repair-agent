"""Startup recovery (P8-T01) against a seeded, inconsistent database: an open call, a stale call pointer, a call row nobody
points at, an outbox lease a dead process held, an overdue timer, a card that never opened, and orphaned uploads. After one
recovery everything is consistent, each fix is counted in the log, and a second run does nothing.
(Port of server/test/boot/recover.test.ts.)"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from app.boot.recover import ORPHAN_UPLOAD_AGE_MS, recover_on_boot
from app.db.repos.calls import insert_call, list_calls
from app.db.repos.events import list_events
from app.db.repos.files import list_files
from app.db.repos.outbox import insert_outbox, list_outbox, save_outbox
from app.db.repos.records import insert_record
from app.db.repos.sessions import get_session
from app.db.repos.timers import Timer, list_timers, upsert_timer
from app.jobs.sweeper import Sweeper
from app.logging import create_logger
from app.session.handlers.call import StartCall
from tests.helpers.chat_flow import answer, chat_session, open_card, session_at_field, store_test_file
from tests.helpers.seed import HASH, seed_session
from tests.helpers.session import CapturedLog, test_services


@pytest.fixture
async def services(db):  # type: ignore[no-untyped-def]
    """Production handlers and the planner."""
    return test_services(db, planner=True)


@pytest.fixture
async def quiet(db):  # type: ignore[no-untyped-def]
    """The same handlers without the planner: a command whose reaction "never ran"."""
    return test_services(db, planner=False)


def counts(log: CapturedLog) -> dict[str, Any]:
    return {message: kwargs["count"] for _, message, kwargs in log.lines if message.startswith("recovery:")}


def recover(db: Any, services: Any, log: Any):
    sweeper = Sweeper(pool=db.pool, processor=services.processor, log=log)
    services.processor.on_timer_scheduled = sweeper.notify

    async def run() -> Any:
        return await recover_on_boot(pool=db.pool, processor=services.processor, sweeper=sweeper, log=log)

    return sweeper, run


class TestRecoverOnBoot:
    async def test_repairs_a_seeded_inconsistent_database_counting_each_fix_and_a_second_run_finds_nothing(
        self, db, services, quiet
    ):
        # 1. A call that was running when the process died: the session points at it.
        calling = await session_at_field(db, services, "serialNumber")
        call_id = f"c{calling[:8]}"
        await services.processor.dispatch(calling, StartCall(call_id=call_id))
        assert (await get_session(db.pool, calling)).active_call_id == call_id

        # 2. A stale pointer: the call row already ended, the session still points at it.
        stale = await seed_session(db.pool)
        await insert_call(db.pool, id=f"s{stale[:8]}", session_id=stale)
        await db.pool.execute(
            "UPDATE calls SET ended_at = now(), end_reason = 'hangup' WHERE id = $1", f"s{stale[:8]}"
        )
        await db.pool.execute("UPDATE sessions SET active_call_id = $2 WHERE id = $1", stale, f"s{stale[:8]}")

        # 3. A call row with no end that its session doesn't point at.
        unpointed = await seed_session(db.pool)
        await insert_call(db.pool, id=f"u{unpointed[:8]}", session_id=unpointed)

        # 4. An outbox lease held by a process that died.
        leased = await seed_session(db.pool)
        await insert_record(
            db.pool, session_id=leased, revision=1, outcome="partial", payload={"revision": 1}, content_hash=HASH
        )
        row = await insert_outbox(db.pool, session_id=leased, revision=1, target="webhook")
        await save_outbox(
            db.pool,
            id=row.id,
            status="sending",
            attempts=1,
            next_attempt_at=datetime.now(UTC) + timedelta(seconds=25),
            last_error=None,
            delivered_at=None,
        )

        # 5. An overdue idle timer on an active session.
        overdue = await session_at_field(db, services, "email")
        await upsert_timer(
            db.pool, Timer(session_id=overdue, kind="idle", due_at=datetime.now(UTC) - timedelta(seconds=60))
        )

        # 6. A card that never opened: an answer committed, its reaction (the planner) never ran.
        missing = await chat_session(db, services)
        first = await open_card(db, missing)
        await answer(quiet, missing, first.id, first.field, "smartphone")
        assert await open_card(db, missing) is None

        # 7. Uploads: an old orphan, an old file an answer names, a fresh unanswered one.
        uploads = await session_at_field(db, services, "purchaseInvoice")
        orphan = await store_test_file(db, uploads)
        kept = await store_test_file(db, uploads)
        fresh = await store_test_file(db, uploads)
        await answer(services, uploads, (await open_card(db, uploads)).id, "purchaseInvoice", f"file:{kept.id}")
        old = datetime.now(UTC) - timedelta(milliseconds=ORPHAN_UPLOAD_AGE_MS + 60_000)
        await db.pool.execute("UPDATE files SET created_at = $2 WHERE id = ANY($1::text[])", [orphan.id, kept.id], old)

        log = CapturedLog()
        sweeper, run = recover(db, services, log)
        report = await run()
        await sweeper.stop()

        # Counted (other sessions in the schema may add their own, hence the lower bounds where a seed isn't unique).
        assert report.dangling_calls >= 3
        assert (report.leases_reclaimed, report.overdue_timers, report.orphan_uploads) == (1, 1, 1)
        assert report.sessions_reconciled >= 3
        assert counts(log) == {
            "recovery: dangling calls ended": report.dangling_calls,
            "recovery: outbox leases reclaimed": 1,
            "recovery: overdue timers fired": 1,
            "recovery: active sessions reconciled": report.sessions_reconciled,
            "recovery: orphaned uploads deleted": 1,
        }

        # 1-3: every call ended with server_restart, no session points at a call, the chat says so.
        assert (await list_calls(db.pool, calling))[0].end_reason == "server_restart"
        assert (await get_session(db.pool, calling)).active_call_id is None
        events = await list_events(db.pool, calling)
        assert [e.payload["reason"] for e in events if e.type == "call.ended"] == ["server_restart"]
        assert any(
            e.type == "chat.message" and "The call was interrupted; let's continue here." in json.dumps(e.payload)
            for e in events
        )
        assert (await get_session(db.pool, stale)).active_call_id is None
        assert isinstance((await list_calls(db.pool, unpointed))[0].ended_at, datetime)
        assert await db.pool.fetchval("SELECT count(*)::int FROM calls WHERE ended_at IS NULL") == 0
        assert await db.pool.fetchval("SELECT count(*)::int FROM sessions WHERE active_call_id IS NOT NULL") == 0
        # The call's session carries on in chat: the card it was on is (still) open.
        assert (await open_card(db, calling)).field == "serialNumber"

        # 4: the lease is back to pending (and due).
        assert [o.status for o in await list_outbox(db.pool, leased)] == ["pending"]
        # 5: the overdue timer fired: the idle finalization produced the partial record.
        session = await get_session(db.pool, overdue)
        assert (session.status, session.outcome, session.current_revision) == ("finalized", "partial", 1)
        assert "idle" not in [t.kind for t in await list_timers(db.pool, overdue)]
        # 6: the missing card is open.
        assert (await open_card(db, missing)).field == "deviceModel"
        # 7: only the old orphan is gone.
        assert sorted(f.id for f in await list_files(db.pool, uploads)) == sorted([kept.id, fresh.id])

        # Idempotent: nothing left to fix (the sweeper's start is the only repeated work).
        again = CapturedLog()
        second_sweeper, second_run = recover(db, services, again)
        report2 = await second_run()
        await second_sweeper.stop()
        assert (report2.dangling_calls, report2.leases_reclaimed, report2.overdue_timers, report2.orphan_uploads) == (
            0,
            0,
            0,
            0,
        )

    async def test_a_failing_session_does_not_stop_the_others(self, db, services):
        good = await seed_session(db.pool)
        bad = await seed_session(db.pool)
        for id_, prefix in [(good, "g"), (bad, "b")]:
            await insert_call(db.pool, id=f"{prefix}{id_[:8]}", session_id=id_)
            await db.pool.execute("UPDATE sessions SET active_call_id = $2 WHERE id = $1", id_, f"{prefix}{id_[:8]}")

        def boom(_name: str) -> None:
            raise RuntimeError("boom")

        failing = test_services(db, failpoint=boom)
        log = CapturedLog()
        sweeper = Sweeper(pool=db.pool, processor=failing.processor, log=log)
        # Every EndCall through the failing processor rolls back (the dispatch throws), so nothing is half-ended.
        report = await recover_on_boot(pool=db.pool, processor=failing.processor, sweeper=sweeper, log=log)
        await sweeper.stop()
        errors = [m for level, m, _ in log.lines if level == "error" and m == "recovery: could not end a dangling call"]
        assert len(errors) >= 2
        assert report.dangling_calls == 0
        # A later recovery with a working processor still repairs them.
        s2, run = recover(db, services, create_logger("silent"))
        fixed = await run()
        await s2.stop()
        assert fixed.dangling_calls >= 2

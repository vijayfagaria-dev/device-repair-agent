"""The timer sweeper and TimerFired (P3-T05): fires on time and on boot, never during a call, issues no queries while idle,
and fires each timer once with two sweepers. A fake clock drives both the sweeper and the processor.
(Port of server/test/jobs/sweeper.test.ts.)"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

import pytest

from app.db.pool import Database
from app.db.repos.events import list_events
from app.db.repos.outbox import list_outbox
from app.db.repos.records import list_records
from app.db.repos.timers import Timer, list_timers, upsert_timer
from app.jobs.sweeper import Sweeper
from app.logging import create_logger
from app.session.handlers.timers import TimerFired
from app.session.timeutil import iso_ms
from tests.helpers.app import wait_for
from tests.helpers.seed import seed_session
from tests.helpers.session import seed_call, test_services

MINUTE = 60_000
log = create_logger("silent")


def utc_ms(*args: int) -> float:
    return datetime(*args, tzinfo=UTC).timestamp() * 1000


def at(ms: float) -> datetime:
    return datetime.fromtimestamp(ms / 1000, UTC)


class FakeClock:
    """A manual clock: set_timeout callbacks run only when advance() passes their time."""

    def __init__(self, start: float) -> None:
        self._now = start
        self._next = 1
        self.pending: dict[int, tuple[float, Callable[[], Any]]] = {}

    def now(self) -> float:
        return self._now

    def set_timeout(self, fn: Callable[[], Any], ms: float) -> int:
        handle = self._next
        self._next += 1
        self.pending[handle] = (self._now + ms, fn)
        return handle

    def clear_timeout(self, handle: Any) -> None:
        self.pending.pop(handle, None)

    async def advance(self, ms: float, sweepers: list[Sweeper]) -> None:
        """Moves time forward, running due callbacks in order and letting each sweep finish before going on. A sweeper
        that keeps rescheduling itself without time passing (a busy loop) fails the test instead of hanging it."""
        target = self._now + ms
        runs = 0
        while True:
            due = sorted(((h, t) for h, t in self.pending.items() if t[0] <= target), key=lambda item: item[1][0])
            if not due:
                break
            if runs >= 100:
                raise AssertionError("runaway: the sweeper rescheduled itself 100 times within one advance()")
            runs += 1
            handle, (when, fn) = due[0]
            del self.pending[handle]
            self._now = when
            fn()
            await asyncio.sleep(0)  # the wake-up starts its sweep
            for sweeper in sweepers:
                await sweeper.settled()
        self._now = target


class Rig:
    def __init__(self, clock: FakeClock, services: Any, sweeper: Sweeper, db: Database) -> None:
        self.clock = clock
        self.services = services
        self.sweeper = sweeper
        self.db = db


class Rigs:
    def __init__(self, schema: Any, db: Database) -> None:
        self.schema = schema
        self.db = db
        self.opened: list[Database] = []

    async def open(self, max_size: int = 4) -> Database:
        own = await self.schema.open(max_size=max_size)
        self.opened.append(own)
        return own

    async def rig(self, start: float | None = None) -> Rig:
        """A processor and sweeper sharing a fake clock and their own pool (so query counts are theirs alone)."""
        clock = FakeClock(start if start is not None else utc_ms(2030, 1, 1, 4))
        own = await self.open()
        services = test_services(own, now=lambda: at(clock.now()))
        sweeper = Sweeper(pool=own.pool, processor=services.processor, log=log, clock=clock, retry_delay_ms=30_000)
        services.processor.on_timer_scheduled = sweeper.notify
        return Rig(clock, services, sweeper, own)

    async def close(self) -> None:
        for own in self.opened:
            await own.pool.close()


@pytest.fixture
async def rigs(schema, db):  # type: ignore[no-untyped-def]
    holder = Rigs(schema, db)
    yield holder
    await holder.close()


async def fired(db: Database, session_id: str) -> list[Any]:
    return [e.payload["kind"] for e in await list_events(db.pool, session_id) if e.type == "timer.fired"]


async def timer_kinds(db: Database, session_id: str) -> list[str]:
    return sorted(t.kind for t in await list_timers(db.pool, session_id))


async def clear_timers(db: Database, session_ids: list[str]) -> None:
    await db.pool.execute("DELETE FROM timers WHERE session_id = ANY($1::uuid[])", session_ids)


class TestFiring:
    async def test_fires_a_due_timer_when_its_time_comes_not_before_a_moved_timer_waits_for_its_new_time(
        self, rigs, db
    ):
        r = await rigs.rig()
        await r.sweeper.start()
        id_ = await seed_session(db.pool)
        await r.services.processor.dispatch(id_, {"type": "Test.Activity"})  # idle due in 15 min (notify: no query)

        await r.clock.advance(10 * MINUTE, [r.sweeper])
        await r.services.processor.dispatch(id_, {"type": "Test.Activity"})  # moves idle to 25 min
        await r.clock.advance(5 * MINUTE + 1, [r.sweeper])  # the old due time passes: the wake-up finds nothing due
        assert await fired(db, id_) == []

        await r.clock.advance(10 * MINUTE - 2, [r.sweeper])
        assert await fired(db, id_) == []
        await r.clock.advance(1, [r.sweeper])  # exactly the new due time
        assert await fired(db, id_) == ["idle"]
        assert await timer_kinds(db, id_) == ["sessionExpiry"]  # fired timers are removed; the 7-day one stays
        await r.sweeper.stop()

    async def test_with_the_real_clock_records_timer_fired_within_5_s_of_due_at(self, rigs, db):
        own = await rigs.open()
        services = test_services(own)
        sweeper = Sweeper(pool=own.pool, processor=services.processor, log=log)
        services.processor.on_timer_scheduled = sweeper.notify
        await sweeper.start()
        id_ = await seed_session(db.pool)
        due_at = at(datetime.now(UTC).timestamp() * 1000 + 300)
        await services.processor.dispatch(id_, {"type": "Test.Noop"})  # nothing scheduled
        await upsert_timer(db.pool, Timer(session_id=id_, kind="noCallStart", due_at=due_at))
        sweeper.notify(due_at)  # as the processor does for timers it commits
        await wait_for(lambda: fired(db, id_), "timer.fired", 5.0, 0.05)
        event = next(e for e in await list_events(db.pool, id_) if e.type == "timer.fired")
        assert event.payload == {"kind": "noCallStart", "dueAt": iso_ms(due_at)}
        assert (event.created_at - due_at).total_seconds() <= 5
        await sweeper.stop()

    async def test_fires_on_boot_a_timer_whose_deadline_passed_while_the_server_was_down(self, rigs, db):
        r = await rigs.rig()
        id_ = await seed_session(db.pool)
        await upsert_timer(
            db.pool, Timer(session_id=id_, kind="sessionExpiry", due_at=at(r.clock.now() - 3 * 60 * MINUTE))
        )
        await r.sweeper.start()
        await r.clock.advance(0, [r.sweeper])  # the boot wake-up is immediate
        assert await fired(db, id_) == ["sessionExpiry"]
        assert await timer_kinds(db, id_) == []
        await r.sweeper.stop()

    async def test_never_fires_idle_during_an_active_call_the_calls_end_re_arms_it_and_then_it_fires(self, rigs, db):
        r = await rigs.rig()
        await r.sweeper.start()
        id_ = await seed_session(db.pool)
        call_id = f"c{id_[:8]}"
        await seed_call(db, id_, call_id)
        await r.services.processor.dispatch(id_, {"type": "Test.StartCall", "callId": call_id})
        # A stale idle timer (e.g. written by an older instance) that comes due mid-call.
        due = at(r.clock.now() + MINUTE)
        await upsert_timer(db.pool, Timer(session_id=id_, kind="idle", due_at=due))
        r.sweeper.notify(due)
        await r.clock.advance(2 * MINUTE, [r.sweeper])
        assert await fired(db, id_) == []
        assert await timer_kinds(db, id_) == []  # removed, not fired

        await r.services.processor.dispatch(id_, {"type": "Test.EndCall"})  # re-arms idle: now + 15 min
        await r.clock.advance(15 * MINUTE, [r.sweeper])
        assert await fired(db, id_) == ["idle"]
        await r.sweeper.stop()


class TestNoPolling:
    """Neon compute budget."""

    # Year 2000: every timer other tests leave in the shared schema is decades later than these clocks.
    QUIET = utc_ms(2000, 1, 1)

    async def test_issues_zero_database_queries_over_a_10_minute_idle_window(self, rigs, db):
        r = await rigs.rig(self.QUIET)
        await r.sweeper.start()  # one read of min(due_at)
        after_start = r.db.stats.acquired
        await r.clock.advance(10 * MINUTE, [r.sweeper])
        assert r.db.stats.acquired == after_start

        # A timer due in 15 min, scheduled through a command: the sweeper learns of it without querying.
        id_ = await seed_session(db.pool)
        await r.services.processor.dispatch(id_, {"type": "Test.Activity"})
        after_command = r.db.stats.acquired
        await r.clock.advance(10 * MINUTE, [r.sweeper])
        assert r.db.stats.acquired == after_command
        await r.sweeper.stop()

    async def test_re_reads_at_most_once_an_hour_the_safety_re_read(self, rigs):
        r = await rigs.rig(utc_ms(1995, 1, 1))
        await r.sweeper.start()
        after_start = r.db.stats.acquired
        await r.clock.advance(59 * MINUTE, [r.sweeper])
        assert r.db.stats.acquired == after_start
        await r.clock.advance(MINUTE, [r.sweeper])
        assert r.db.stats.acquired - after_start == 2  # claim (none due) + min(due_at)
        await r.sweeper.stop()

    async def test_a_timer_whose_command_keeps_failing_doesnt_hold_up_other_sessions_timers(self, rigs, db):
        clock = FakeClock(utc_ms(1980, 1, 1))
        own = await rigs.open()
        services = test_services(own, now=lambda: at(clock.now()))
        bad, good = await seed_session(db.pool), await seed_session(db.pool)
        # first in order
        await upsert_timer(db.pool, Timer(session_id=bad, kind="noCallStart", due_at=at(clock.now() - 2 * MINUTE)))
        await upsert_timer(db.pool, Timer(session_id=good, kind="noCallStart", due_at=at(clock.now() - MINUTE)))
        failures = 0

        class Processor:
            async def dispatch(self, session_id: str, command: Any) -> Any:
                nonlocal failures
                if session_id != bad:
                    return await services.processor.dispatch(session_id, command)
                failures += 1
                raise RuntimeError("handler bug for this one session")

        sweeper = Sweeper(pool=own.pool, processor=Processor(), log=log, clock=clock, retry_delay_ms=30_000)  # type: ignore[arg-type]
        await sweeper.start()
        await clock.advance(0, [sweeper])
        assert await fired(db, good) == ["noCallStart"]
        assert failures == 1
        assert [t[0] - clock.now() for t in clock.pending.values()] == [30_000]  # no busy loop on the bad one
        await clock.advance(30_000, [sweeper])
        assert failures == 2
        await sweeper.stop()

    async def test_stop_during_a_sweep_ends_it_after_the_timer_in_progress_not_after_the_whole_backlog(self, rigs, db):
        clock = FakeClock(utc_ms(1975, 1, 1))
        own = await rigs.open()
        services = test_services(own, now=lambda: at(clock.now()))
        ids = [await seed_session(db.pool), await seed_session(db.pool), await seed_session(db.pool)]
        for index, id_ in enumerate(ids):
            due = at(clock.now() - (3 - index) * MINUTE)
            await upsert_timer(db.pool, Timer(session_id=id_, kind="noCallStart", due_at=due))
        stopping: asyncio.Future[None] | None = None

        class Processor:
            async def dispatch(self, session_id: str, command: Any) -> Any:
                nonlocal stopping
                result = await services.processor.dispatch(session_id, command)
                if stopping is None:  # shutdown begins while the first timer is being handled
                    stopping = asyncio.ensure_future(sweeper.stop())
                    await asyncio.sleep(0)  # a JS promise runs its body at once: let stop() set its flag
                return result

        sweeper = Sweeper(pool=own.pool, processor=Processor(), log=log, clock=clock, batch_size=2)  # type: ignore[arg-type]
        await sweeper.start()
        await clock.advance(0, [sweeper])
        assert stopping is not None
        await stopping
        assert [await fired(db, ids[0]), await fired(db, ids[1]), await fired(db, ids[2])] == [
            ["noCallStart"],
            [],
            [],
        ]
        assert len(clock.pending) == 0
        await clear_timers(db, ids)

    async def test_after_a_database_error_retries_after_the_retry_delay_instead_of_spinning_on_an_overdue_timer(
        self, rigs, db
    ):
        r = await rigs.rig()
        id_ = await seed_session(db.pool)
        await upsert_timer(db.pool, Timer(session_id=id_, kind="noCallStart", due_at=at(r.clock.now() - MINUTE)))
        await r.sweeper.start()
        await r.db.pool.close()  # the database goes away
        await r.clock.advance(0, [r.sweeper])  # the overdue wake-up fails
        assert [t[0] - r.clock.now() for t in r.clock.pending.values()] == [30_000]
        await r.sweeper.stop()


class _EarliestReadHook:
    """A pool whose min(due_at) reads run `during` after the query returns and before the caller sees the result."""

    def __init__(self, pool: Any, during: Callable[[], Awaitable[None]]) -> None:
        self._pool = pool
        self._during = during
        self.armed = False

    async def fetchval(self, query: str, *args: Any) -> Any:
        result = await self._pool.fetchval(query, *args)
        if self.armed and "min(due_at)" in query:
            self.armed = False
            await self._during()
        return result

    def __getattr__(self, name: str) -> Any:
        return getattr(self._pool, name)


class TestATimerCommittedWhileTheSweeperReadsMinDueAt:
    """The read's snapshot predates the commit, so its result can't include the new timer; the notify() that the commit sent
    must not be overwritten by that stale result (else the timer waits for the hourly re-read)."""

    @pytest.mark.parametrize("when", ["start", "sweep"])
    async def test_still_wakes_on_time(self, rigs, db, when):
        clock = FakeClock({"start": utc_ms(1990, 1, 1), "sweep": utc_ms(1985, 1, 1)}[when])
        own = await rigs.open()
        services = test_services(own, now=lambda: at(clock.now()))
        id_ = await seed_session(db.pool)

        async def during() -> None:
            # idle due in 15 min, reported via notify()
            await services.processor.dispatch(id_, {"type": "Test.Activity"})

        hook = _EarliestReadHook(own.pool, during)
        sweeper = Sweeper(pool=hook, processor=services.processor, log=log, clock=clock)
        services.processor.on_timer_scheduled = sweeper.notify
        if when == "start":
            hook.armed = True
        await sweeper.start()
        if when == "sweep":
            hook.armed = True
            await sweeper.sweep()
        await clock.advance(15 * MINUTE, [sweeper])
        assert await fired(db, id_) == ["idle"]
        await sweeper.stop()


class TestTwoSweepersOnOneDatabase:
    """Deploy overlap."""

    async def test_fire_each_timer_exactly_once(self, rigs, db):
        a = await rigs.rig()
        b = await rigs.rig()
        ids = list(await asyncio.gather(*(seed_session(db.pool) for _ in range(15))))
        # Kinds that don't affect each other: idle and sessionExpiry finalize (and close) the session, which clears the rest.
        kinds = ["orphanUploads", "noCallStart"]
        for id_ in ids:
            for kind in kinds:
                await upsert_timer(db.pool, Timer(session_id=id_, kind=kind, due_at=at(a.clock.now() - MINUTE)))
        await asyncio.gather(a.sweeper.start(), b.sweeper.start())
        await asyncio.gather(a.sweeper.sweep(), b.sweeper.sweep())
        await asyncio.gather(a.sweeper.settled(), b.sweeper.settled())
        for id_ in ids:
            assert sorted(await fired(db, id_)) == sorted(kinds), id_
            assert await timer_kinds(db, id_) == []
        await asyncio.gather(a.sweeper.stop(), b.sweeper.stop())

    async def test_finalize_an_idle_session_exactly_once_even_when_both_fire_its_timer(self, rigs, db):
        a = await rigs.rig()
        b = await rigs.rig()
        ids = list(await asyncio.gather(*(seed_session(db.pool) for _ in range(10))))
        for id_ in ids:
            await upsert_timer(db.pool, Timer(session_id=id_, kind="idle", due_at=at(a.clock.now() - MINUTE)))
        await asyncio.gather(a.sweeper.start(), b.sweeper.start())
        await asyncio.gather(a.sweeper.sweep(), b.sweeper.sweep())
        await asyncio.gather(a.sweeper.settled(), b.sweeper.settled())
        for id_ in ids:
            events = await list_events(db.pool, id_)
            assert len([e for e in events if e.type == "session.finalized"]) == 1, id_
            assert len(await list_records(db.pool, id_)) == 1, id_
            assert len(await list_outbox(db.pool, id_)) == 1, id_
            assert await timer_kinds(db, id_) == []
        await asyncio.gather(a.sweeper.stop(), b.sweeper.stop())


class TestTimerFired:
    """Re-checked under the session lock."""

    async def test_is_a_no_op_for_a_timer_that_is_gone_or_not_yet_due(self, rigs, db):
        r = await rigs.rig()
        id_ = await seed_session(db.pool)
        due_at = at(r.clock.now())
        first = await r.services.processor.dispatch(id_, TimerFired(kind="idle", due_at=due_at))
        assert first.reply == {"fired": False, "reason": "notDue"}
        await upsert_timer(db.pool, Timer(session_id=id_, kind="idle", due_at=at(r.clock.now() + MINUTE)))
        result = await r.services.processor.dispatch(id_, TimerFired(kind="idle", due_at=due_at))
        assert (result.reply, result.update) == ({"fired": False, "reason": "notDue"}, None)
        assert await timer_kinds(db, id_) == ["idle"]

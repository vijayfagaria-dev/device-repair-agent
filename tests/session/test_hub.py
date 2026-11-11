"""The session hub (P3-T03) and the per-session mutex (P3-T01): ordering, listener isolation, cleanup. Pure unit tests."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import pytest

from app.db.repos.events import SessionEvent
from app.session.hub import SessionHub, SessionUpdate
from app.session.mutex import KeyedMutex

session: Any = SimpleNamespace(id="s1", version=1)


def update(seq: int, session_id: str = "s1") -> SessionUpdate:
    return SessionUpdate(
        session_id=session_id,
        events=[
            SessionEvent(
                session_id=session_id,
                seq=seq,
                type="test.event",
                channel="system",
                payload={},
                created_at=datetime(1970, 1, 1, tzinfo=UTC),
            )
        ],
        session=session,
    )


def seqs(updates: list[SessionUpdate]) -> list[int]:
    return [e.seq for u in updates for e in u.events]


class FailingLog:
    def __init__(self) -> None:
        self.errors: list[str] = []

    def error(self, message: str, **kwargs: Any) -> None:
        self.errors.append(message)


class TestSessionHub:
    def test_delivers_identical_ordered_streams_to_every_subscriber_of_a_session_and_nothing_from_other_sessions(
        self,
    ) -> None:
        hub = SessionHub()
        a: list[SessionUpdate] = []
        b: list[SessionUpdate] = []
        hub.subscribe("s1", a.append)
        hub.subscribe("s1", b.append)
        for seq in range(1, 51):
            hub.publish(update(seq))
            hub.publish(update(seq, "s2"))
        assert seqs(a) == list(range(1, 51))
        assert b == a

    def test_isolates_listeners_one_that_throws_does_not_stop_the_others_or_reach_the_publisher(self) -> None:
        log = FailingLog()
        hub = SessionHub(log)
        got: list[int] = []

        def broken(_u: SessionUpdate) -> None:
            raise RuntimeError("broken listener")

        hub.subscribe("s1", broken)
        hub.subscribe("s1", lambda u: got.extend(seqs([u])))
        hub.publish(update(1))
        assert got == [1]
        assert log.errors == ["session listener failed"]

    def test_returns_the_listener_count_to_0_after_every_unsubscribe_idempotent_and_frees_the_sessions_entry(
        self,
    ) -> None:
        hub = SessionHub()

        def listener(_u: SessionUpdate) -> None:
            pass

        off_a = hub.subscribe("s1", listener)
        off_b = hub.subscribe("s1", listener)  # the same function twice is two subscriptions
        off_c = hub.subscribe("s2", listener)
        assert hub.listener_count("s1") == 2
        assert hub.listener_count() == 3
        off_a()
        off_a()
        assert hub.listener_count("s1") == 1
        off_b()
        off_c()
        assert hub.listener_count() == 0

    def test_a_listener_that_unsubscribes_during_delivery_does_not_disturb_the_others(self) -> None:
        hub = SessionHub()
        got: list[str] = []

        def first(_u: SessionUpdate) -> None:
            got.append("first")
            off()

        off = hub.subscribe("s1", first)
        hub.subscribe("s1", lambda _u: got.append("second"))
        hub.publish(update(1))
        hub.publish(update(2))
        assert got == ["first", "second", "second"]


class TestKeyedMutex:
    async def test_runs_work_for_one_key_one_at_a_time_in_call_order_and_other_keys_in_parallel(self) -> None:
        mutex = KeyedMutex()
        log: list[str] = []

        async def task(key: str, name: str, ms: int) -> None:
            async def work() -> None:
                log.append(f"start {name}")
                await asyncio.sleep(ms / 1000)
                log.append(f"end {name}")

            await mutex.run(key, work)

        await asyncio.gather(task("a", "a1", 20), task("a", "a2", 1), task("b", "b1", 5))
        assert log.index("end a1") < log.index("start a2")
        assert log.index("start b1") < log.index("end a1")
        assert mutex.size == 0

    async def test_releases_on_failure_and_the_failure_reaches_only_its_caller(self) -> None:
        mutex = KeyedMutex()

        async def boom() -> None:
            raise RuntimeError("boom")

        async def ok() -> str:
            return "ok"

        failed = asyncio.ensure_future(mutex.run("a", boom))
        nxt = asyncio.ensure_future(mutex.run("a", ok))
        with pytest.raises(RuntimeError, match="boom"):
            await failed
        assert await nxt == "ok"
        assert mutex.size == 0

    async def test_is_released_before_run_settles_so_the_caller_can_immediately_queue_more_work_for_the_key(
        self,
    ) -> None:
        mutex = KeyedMutex()

        async def nothing() -> None:
            return None

        async def again() -> str:
            return "again"

        await mutex.run("a", nothing)
        assert await asyncio.wait_for(mutex.run("a", again), 0.2) == "again"

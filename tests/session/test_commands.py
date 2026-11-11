"""The command processor (P3-T01; D11): serialization, rollback, publish after commit, re-entrancy, effects and the
activity timer rules (P3-T05 steps 1-2), against the throwaway test Postgres."""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import asyncpg
import pytest

from app.db.repos.chat_messages import list_chat_messages
from app.db.repos.events import list_events
from app.db.repos.field_candidates import list_field_candidates
from app.db.repos.input_requests import get_input_request
from app.db.repos.sessions import get_session
from app.db.repos.timers import list_timers
from app.protocol.enums import Role
from app.session.commands import SessionNotFoundError, UnsupportedCommandError
from app.session.hub import SessionUpdate
from tests.helpers.match import assert_matches
from tests.helpers.seed import seed_session
from tests.helpers.session import TEST_TIMERS, test_services


@pytest.fixture
async def services(db):  # type: ignore[no-untyped-def]
    return test_services(db)


def rng(n: int) -> list[int]:
    return list(range(n))


class TestSerialization:
    async def test_100_concurrent_commands_on_one_session_get_consecutive_seq_values_with_no_lost_writes(
        self, db, services
    ) -> None:
        id_ = await seed_session(db.pool)
        await asyncio.gather(*(services.processor.dispatch(id_, {"type": "Test.Append", "n": n}) for n in rng(100)))
        events = await list_events(db.pool, id_)
        assert [e.seq for e in events] == [n + 1 for n in rng(100)]
        assert {e.payload["n"] for e in events} == set(rng(100))
        session = await get_session(db.pool, id_)
        assert session is not None and session.version == 100
        assert services.processor.busy_sessions == 0

    async def test_also_when_they_are_split_across_two_processor_instances_with_separate_mutexes_deploy_overlap(
        self, db, schema, services
    ) -> None:
        other = await schema.open(max_size=10)  # another process: its own pool, mutex and hub
        try:
            second = test_services(other)
            id_ = await seed_session(db.pool)
            started = asyncio.get_running_loop().time()
            await asyncio.gather(
                *(
                    (services if n % 2 == 0 else second).processor.dispatch(id_, {"type": "Test.Append", "n": n})
                    for n in rng(100)
                )
            )
            events = await list_events(db.pool, id_)
            assert [e.seq for e in events] == [n + 1 for n in rng(100)]
            assert {e.payload["n"] for e in events} == set(rng(100))
            session = await get_session(db.pool, id_)
            assert session is not None and session.version == 100
            assert asyncio.get_running_loop().time() - started < 10
        finally:
            await other.close()

    async def test_keeps_per_session_publish_order_equal_to_commit_order(self, db, services) -> None:
        id_ = await seed_session(db.pool)
        seen: list[int] = []
        unsubscribe = services.hub.subscribe(id_, lambda update: seen.extend(e.seq for e in update.events))
        await asyncio.gather(*(services.processor.dispatch(id_, {"type": "Test.Append", "n": n}) for n in rng(30)))
        unsubscribe()
        assert seen == [n + 1 for n in rng(30)]


class TestRollback:
    async def test_a_throwing_handler_writes_nothing_and_publishes_nothing(self, db, services) -> None:
        id_ = await seed_session(db.pool)
        published: list[SessionUpdate] = []
        unsubscribe = services.hub.subscribe(id_, published.append)
        with pytest.raises(RuntimeError, match="handler failed on purpose"):
            await services.processor.dispatch(id_, {"type": "Test.Throw"})
        with pytest.raises(asyncpg.PostgresError):
            await services.processor.dispatch(id_, {"type": "Test.ThrowAfterWrite"})
        unsubscribe()
        assert published == []
        assert await list_events(db.pool, id_) == []
        session = await get_session(db.pool, id_)
        assert session is not None and session.version == 0
        # The session still works afterwards: the mutex was released.
        await services.processor.dispatch(id_, {"type": "Test.Append", "n": 1})
        assert [e.seq for e in await list_events(db.pool, id_)] == [1]

    async def test_a_no_op_decision_writes_and_publishes_nothing_and_returns_the_reply(self, db, services) -> None:
        id_ = await seed_session(db.pool)
        published: list[SessionUpdate] = []
        unsubscribe = services.hub.subscribe(id_, published.append)
        result = await services.processor.dispatch(id_, {"type": "Test.Noop"})
        unsubscribe()
        assert (result.reply, result.update) == ("nothing to do", None)
        assert published == []
        session = await get_session(db.pool, id_)
        assert session is not None and session.version == 0

    async def test_refuses_an_unknown_command_before_touching_the_database_and_an_unknown_session(
        self, db, services
    ) -> None:
        before = db.stats.acquired
        with pytest.raises(UnsupportedCommandError):
            await services.processor.dispatch(str(uuid.uuid4()), {"type": "NoSuchCommand"})
        assert db.stats.acquired == before
        with pytest.raises(SessionNotFoundError):
            await services.processor.dispatch(str(uuid.uuid4()), {"type": "Test.Noop"})


class TestPublishAfterCommit:
    async def test_listeners_see_committed_state_the_published_rows_are_visible_to_another_connection(
        self, db, schema, services
    ) -> None:
        id_ = await seed_session(db.pool)
        other = await schema.open(max_size=1)
        reads: list[asyncio.Future[Any]] = []
        try:
            unsubscribe = services.hub.subscribe(
                id_,
                lambda update: reads.append(
                    asyncio.ensure_future(
                        other.pool.fetchval(
                            "SELECT count(*)::int AS n FROM events WHERE session_id = $1 AND seq = $2",
                            id_,
                            update.events[0].seq,
                        )
                    )
                ),
            )
            await services.processor.dispatch(id_, {"type": "Test.Append", "n": 1})
            unsubscribe()
            assert await asyncio.gather(*reads) == [1]
        finally:
            await other.close()

    async def test_a_listener_that_dispatches_a_command_does_not_deadlock_under_2_s(self, db, services) -> None:
        id_ = await seed_session(db.pool)
        nested: list[asyncio.Future[Any]] = []

        def listener(_update: SessionUpdate) -> None:
            if not nested:
                nested.append(asyncio.ensure_future(services.processor.dispatch(id_, {"type": "Test.Append", "n": 2})))

        unsubscribe = services.hub.subscribe(id_, listener)
        started = asyncio.get_running_loop().time()
        await asyncio.wait_for(services.processor.dispatch(id_, {"type": "Test.Append", "n": 1}), 2)
        await asyncio.wait_for(nested[0], 2)
        unsubscribe()
        assert asyncio.get_running_loop().time() - started < 2
        assert [e.payload["n"] for e in await list_events(db.pool, id_)] == [1, 2]

    async def test_reactions_run_after_every_command_and_after_release_so_they_may_dispatch_more_commands(
        self, db
    ) -> None:
        local = test_services(db)
        id_ = await seed_session(db.pool)
        reacted: list[int | None] = []

        async def reaction(session_id: str, update: SessionUpdate | None, command: Any) -> None:
            reacted.append(update.events[0].seq if update and update.events else None)
            # Like reconcile: act once, then find nothing to do.
            if len(reacted) == 1:
                await local.processor.dispatch(session_id, {"type": "Test.Append", "n": 2})

        local.processor.add_reaction(reaction)
        await asyncio.wait_for(local.processor.dispatch(id_, {"type": "Test.Append", "n": 1}), 2)
        assert reacted == [1, 2]
        await local.processor.react(id_)  # on demand (chat connect, boot)
        assert reacted == [1, 2, None]

    async def test_a_failing_reaction_is_logged_and_the_command_stays_committed(self, db) -> None:
        local = test_services(db)

        def reaction(*_args: Any) -> None:
            raise RuntimeError("reaction failed")

        local.processor.add_reaction(reaction)
        id_ = await seed_session(db.pool)
        result = await local.processor.dispatch(id_, {"type": "Test.Append", "n": 1})
        assert result.update is not None and result.update.session_id == id_
        assert len(await list_events(db.pool, id_)) == 1


class TestEffects:
    async def test_writes_each_events_row_with_the_events_seq_and_copies_the_rows_data_into_the_payload(
        self, db, services
    ) -> None:
        id_ = await seed_session(db.pool)
        await services.processor.dispatch(id_, {"type": "Test.Say", "message_id": "msgA1", "text": "Hello"})
        await services.processor.dispatch(
            id_,
            {
                "type": "Test.Candidate",
                "field": "email",
                "raw": "a@b.co",
                "normalized": "a@b.co",
                "evidence": "they said a at b",
            },
        )
        [message] = await list_chat_messages(db.pool, id_)
        assert_matches(message, {"id": "msgA1", "event_seq": 1, "role": Role.AGENT, "text": "Hello"})
        events = await list_events(db.pool, id_)
        assert events[0].payload == {"message": {"id": "msgA1", "role": "agent", "text": "Hello", "requestId": None}}
        assert_matches(
            (await list_field_candidates(db.pool, id_))[0],
            {"event_seq": 2, "field": "email", "evidence": "they said a at b"},
        )
        # The LLM's evidence stays in its row; it isn't copied into the timeline.
        assert "evidence" not in events[1].payload["candidate"]

    async def test_keeps_sessions_open_request_id_in_step_with_the_open_card_and_refuses_a_second_open_card(
        self, db, services
    ) -> None:
        id_ = await seed_session(db.pool)
        await services.processor.dispatch(id_, {"type": "Test.OpenCard", "request_id": "req_email_1", "field": "email"})
        session = await get_session(db.pool, id_)
        assert session is not None and session.open_request_id == "req_email_1"
        request = await get_input_request(db.pool, id_, "req_email_1")
        assert request is not None and request.status == "open"

        # A second open card fails the whole command (input_requests_one_open_idx), so nothing of it is written.
        before = len(await list_events(db.pool, id_))
        with pytest.raises(Exception, match="input_requests_one_open_idx"):
            await services.processor.dispatch(
                id_, {"type": "Test.OpenCard", "request_id": "req_serialNumber_1", "field": "serialNumber"}
            )
        assert await get_input_request(db.pool, id_, "req_serialNumber_1") is None
        assert len(await list_events(db.pool, id_)) == before

        await services.processor.dispatch(id_, {"type": "Test.CancelCard", "request_id": "req_email_1"})
        session = await get_session(db.pool, id_)
        assert session is not None and session.open_request_id is None
        request = await get_input_request(db.pool, id_, "req_email_1")
        assert request is not None and request.status == "cancelled"


def iso(moment: datetime) -> str:
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


class TestActivityAndTimers:
    async def test_activity_moves_last_activity_at_the_idle_timer_and_the_session_expiry_timer_a_call_removes_idle_its_end_re_arms_it(
        self, db
    ) -> None:
        now = datetime(2026, 11, 10, 4, 0, 0, tzinfo=UTC)
        scheduled: list[datetime] = []
        local = test_services(db, now=lambda: now)
        local.processor.on_timer_scheduled = scheduled.append
        id_ = await seed_session(db.pool)

        async def timers() -> dict[str, str]:
            return {t.kind: iso(t.due_at) for t in await list_timers(db.pool, id_)}

        def plus(ms: float) -> str:
            return iso(now + timedelta(milliseconds=ms))

        await local.processor.dispatch(id_, {"type": "Test.Activity"})
        assert await timers() == {
            "idle": plus(TEST_TIMERS.idle_timeout_ms),
            "sessionExpiry": plus(TEST_TIMERS.session_lifetime_ms),
        }
        session = await get_session(db.pool, id_)
        assert session is not None and iso(session.last_activity_at) == iso(now)
        assert sorted(iso(d) for d in scheduled) == sorted(
            [plus(TEST_TIMERS.idle_timeout_ms), plus(TEST_TIMERS.session_lifetime_ms)]
        )

        now = datetime(2026, 11, 10, 4, 5, 0, tzinfo=UTC)
        await local.processor.dispatch(id_, {"type": "Test.StartCall", "call_id": "callA"})
        assert list(await timers()) == ["sessionExpiry"]  # a live call removes the idle timer

        await local.processor.dispatch(id_, {"type": "Test.Activity"})  # activity during a call doesn't arm idle
        assert list(await timers()) == ["sessionExpiry"]

        now = datetime(2026, 11, 10, 4, 9, 0, tzinfo=UTC)
        await local.processor.dispatch(id_, {"type": "Test.EndCall"})
        assert (await timers())["idle"] == plus(TEST_TIMERS.idle_timeout_ms)  # the call's end re-arms it

        # Non-activity commands leave timers and last_activity_at alone.
        now = datetime(2026, 11, 10, 4, 10, 0, tzinfo=UTC)
        before = await timers()
        await local.processor.dispatch(id_, {"type": "Test.Append", "n": 1})
        assert await timers() == before
        session = await get_session(db.pool, id_)
        assert session is not None and iso(session.last_activity_at) == "2026-11-10T04:05:00.000Z"

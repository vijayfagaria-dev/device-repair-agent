"""Lazy session creation against the test Postgres (P1-T03)."""

from __future__ import annotations

import asyncio
import uuid

import pytest

from app.db.repos.events import list_events
from app.db.repos.sessions import get_session
from app.session.creation_limit import CreationLimiter
from app.session.ensure_session import CreationLimit, ensure_session
from tests.helpers.db import create_migrated_schema
from tests.helpers.match import assert_matches


def limiter(max_: int) -> CreationLimiter:
    return CreationLimiter(max=max_, window_ms=60_000)


def new_id() -> str:
    return str(uuid.uuid4())


class TestEnsureSession:
    async def test_creates_an_unknown_session_with_defaults_and_one_session_created_event(self, db) -> None:
        id_ = new_id()
        result = await ensure_session(db.pool, id_, via="chat")
        assert result.ok and result.created
        assert_matches(result.session, {"id": id_, "status": "active", "version": 0, "outcome": None})
        assert await get_session(db.pool, id_) is not None
        events = await list_events(db.pool, id_)
        assert len(events) == 1
        assert_matches(
            events[0], {"seq": 1, "type": "session.created", "channel": "system", "payload": {"via": "chat"}}
        )

    async def test_loads_an_existing_session_without_writing_anything(self, db) -> None:
        id_ = new_id()
        await ensure_session(db.pool, id_, via="chat")
        before = await get_session(db.pool, id_)
        result = await ensure_session(db.pool, id_, via="call")
        assert result.ok and not result.created
        assert await get_session(db.pool, id_) == before  # version and last activity untouched (not user activity)
        assert len(await list_events(db.pool, id_)) == 1

    async def test_creates_a_new_id_exactly_once_under_12_concurrent_calls(self, db) -> None:
        id_ = new_id()
        results = await asyncio.gather(*(ensure_session(db.pool, id_, via="chat") for _ in range(12)))
        assert all(r.ok for r in results)
        assert len([r for r in results if r.ok and r.created]) == 1
        assert len(await list_events(db.pool, id_)) == 1

    class TestRateLimit:
        async def test_refuses_new_sessions_beyond_the_limit_for_that_key_creating_nothing(self, db) -> None:
            lim = limiter(2)
            for _ in range(2):
                result = await ensure_session(db.pool, new_id(), via="chat", limit=CreationLimit(lim, "1.2.3.4"))
                assert result.ok
            refused_id = new_id()
            refused = await ensure_session(db.pool, refused_id, via="chat", limit=CreationLimit(lim, "1.2.3.4"))
            assert (refused.ok, refused.reason) == (False, "rate_limited")
            assert await get_session(db.pool, refused_id) is None
            # Another client is unaffected.
            assert (await ensure_session(db.pool, new_id(), via="chat", limit=CreationLimit(lim, "5.6.7.8"))).ok

        async def test_never_limits_loading_an_existing_session(self, db) -> None:
            lim = limiter(1)
            id_ = new_id()
            await ensure_session(db.pool, id_, via="chat", limit=CreationLimit(lim, "k"))
            for _ in range(5):
                result = await ensure_session(db.pool, id_, via="chat", limit=CreationLimit(lim, "k"))
                assert result.ok and not result.created

        async def test_does_not_charge_a_call_that_joined_a_session_someone_else_created_concurrently(self, db) -> None:
            lim = limiter(1)
            id_ = new_id()
            results = await asyncio.gather(
                *(ensure_session(db.pool, id_, via="chat", limit=CreationLimit(lim, "k2")) for _ in range(6))
            )
            # All six get the session (the losers either joined after the insert or re-read it after the limit refused them).
            assert all(r.ok for r in results)
            assert len([r for r in results if r.ok and r.created]) == 1
            # Exactly one slot was used: the next new session is refused.
            assert not (await ensure_session(db.pool, new_id(), via="chat", limit=CreationLimit(lim, "k2"))).ok

    async def test_rolls_back_completely_and_returns_the_slot_when_the_event_cannot_be_written(
        self, test_database_url
    ) -> None:
        broken = await create_migrated_schema(test_database_url, "ensure_broken")
        try:
            # Make append_event fail inside the transaction, after the session insert.
            await broken.db.pool.execute("ALTER TABLE events RENAME TO events_gone")
            lim = limiter(1)
            id_ = new_id()
            with pytest.raises(Exception, match="events"):
                await ensure_session(broken.db.pool, id_, via="chat", limit=CreationLimit(lim, "k"))
            assert await get_session(broken.db.pool, id_) is None  # no session without its event
            assert lim.try_acquire("k") is True  # the slot came back
            assert broken.db.pool.get_idle_size() == broken.db.pool.get_size()  # no leaked connection
        finally:
            await broken.drop()

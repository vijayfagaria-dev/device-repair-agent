from __future__ import annotations

from datetime import UTC, datetime, timedelta

import asyncpg
import pytest

from app.db.repos.calls import end_call, get_active_call, get_call, insert_call
from tests.repos.seed import seed_session


async def test_insert_call_starts_a_call_a_second_active_call_in_the_session_is_rejected(db) -> None:
    id = await seed_session(db.pool)
    call = await insert_call(db.pool, id=f"c_{id}_1", session_id=id)
    assert (call.id, call.session_id, call.ended_at, call.end_reason) == (f"c_{id}_1", id, None, None)
    assert isinstance(call.started_at, datetime)
    with pytest.raises(asyncpg.PostgresError) as err:
        await insert_call(db.pool, id=f"c_{id}_2", session_id=id)
    assert err.value.sqlstate == "23505"
    at = datetime(2026, 11, 8, 8, 0, tzinfo=UTC)
    other = await insert_call(db.pool, id=f"c_{id}_x", session_id=await seed_session(db.pool), started_at=at)
    assert other.started_at == at


async def test_get_call_finds_a_call_by_id(db) -> None:
    id = await seed_session(db.pool)
    await insert_call(db.pool, id=f"c_{id}_1", session_id=id)
    found = await get_call(db.pool, f"c_{id}_1")
    assert found is not None and found.session_id == id
    assert await get_call(db.pool, "c_missing") is None


async def test_get_active_call_returns_the_sessions_call_until_it_ends(db) -> None:
    id = await seed_session(db.pool)
    assert await get_active_call(db.pool, id) is None
    await insert_call(db.pool, id=f"c_{id}_1", session_id=id)
    active = await get_active_call(db.pool, id)
    assert active is not None and active.id == f"c_{id}_1"
    await end_call(db.pool, id=f"c_{id}_1", reason="hangup")
    assert await get_active_call(db.pool, id) is None


async def test_end_call_ends_an_active_call_once_the_first_end_wins_and_allows_a_new_call(db) -> None:
    id = await seed_session(db.pool)
    started = await insert_call(db.pool, id=f"c_{id}_1", session_id=id)
    ended_at = started.started_at + timedelta(seconds=90)
    ended = await end_call(db.pool, id=f"c_{id}_1", reason="hangup", ended_at=ended_at)
    assert ended is not None and ended.ended_at == ended_at and ended.end_reason == "hangup"
    assert await end_call(db.pool, id=f"c_{id}_1", reason="server_restart") is None
    again = await get_call(db.pool, f"c_{id}_1")
    assert again is not None and again.end_reason == "hangup"
    assert await end_call(db.pool, id="c_missing", reason="hangup") is None
    assert (await insert_call(db.pool, id=f"c_{id}_2", session_id=id)).ended_at is None

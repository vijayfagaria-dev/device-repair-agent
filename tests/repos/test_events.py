from __future__ import annotations

from datetime import datetime

import asyncpg
import pytest

from app.db.repos.events import append_event, list_events, next_event_seq
from app.db.repos.field_candidates import insert_field_candidate, list_field_candidates
from app.db.repos.sessions import lock_session
from app.db.tx import transaction
from tests.repos.seed import seed_session


async def test_next_event_seq_starts_at_1_and_follows_the_last_event_it_is_per_session(db) -> None:
    a, b = await seed_session(db.pool), await seed_session(db.pool)
    async with transaction(db.pool) as tx:
        await lock_session(tx, a)
        assert await next_event_seq(tx, a) == 1
        await append_event(tx, session_id=a, type="x", channel="system")
        await append_event(tx, session_id=a, type="y", channel="system")
        assert await next_event_seq(tx, a) == 3
        assert await next_event_seq(tx, b) == 1


async def test_append_event_stores_type_channel_and_payload_default_at_consecutive_seqs(db) -> None:
    id = await seed_session(db.pool)
    async with transaction(db.pool) as tx:
        await lock_session(tx, id)
        first = await append_event(tx, session_id=id, type="session.created", channel="system")
        second = await append_event(
            tx, session_id=id, type="chat.message", channel="chat", payload={"text": "hi", "n": [1, None]}
        )
    assert (first.session_id, first.seq, first.type, first.channel, first.payload) == (
        id,
        1,
        "session.created",
        "system",
        {},
    )
    assert (second.seq, second.channel, second.payload) == (2, "chat", {"text": "hi", "n": [1, None]})
    assert isinstance(second.created_at, datetime)


async def test_append_event_with_a_seq_from_next_event_seq_lets_rows_refer_to_the_event_before_it_exists(db) -> None:
    id = await seed_session(db.pool)
    async with transaction(db.pool) as tx:
        await lock_session(tx, id)
        seq = await next_event_seq(tx, id)
        await insert_field_candidate(
            tx, session_id=id, event_seq=seq, field="email", source="chat", raw="a@b.co", status="valid"
        )
        assert (await append_event(tx, session_id=id, type="field.collected", channel="chat", seq=seq)).seq == seq
    assert len(await list_field_candidates(db.pool, id)) == 1


async def test_a_duplicate_seq_is_rejected_by_unique_session_id_seq(db) -> None:
    id = await seed_session(db.pool)
    with pytest.raises(asyncpg.PostgresError) as err:
        async with transaction(db.pool) as tx:
            await append_event(tx, session_id=id, type="x", channel="system", seq=1)
            await append_event(tx, session_id=id, type="y", channel="system", seq=1)
    assert err.value.sqlstate == "23505"
    assert err.value.constraint_name == "events_session_seq_key"


async def test_list_events_returns_events_in_seq_order_optionally_after_a_seq(db) -> None:
    id = await seed_session(db.pool)
    async with transaction(db.pool) as tx:
        await lock_session(tx, id)
        for type in ("a", "b", "c"):
            await append_event(tx, session_id=id, type=type, channel="system")
    assert [(e.seq, e.type) for e in await list_events(db.pool, id)] == [(1, "a"), (2, "b"), (3, "c")]
    assert [e.type for e in await list_events(db.pool, id, after_seq=2)] == ["c"]
    assert await list_events(db.pool, await seed_session(db.pool)) == []


async def test_events_are_append_only_updates_and_deletes_are_rejected(db) -> None:
    id = await seed_session(db.pool)
    async with transaction(db.pool) as tx:
        await lock_session(tx, id)
        await append_event(tx, session_id=id, type="a", channel="system")
    for statement in ("UPDATE events SET type = 'z'", "DELETE FROM events"):
        with pytest.raises(asyncpg.PostgresError) as err:
            await db.pool.execute(statement)
        assert err.value.sqlstate == "23001"
    assert [e.type for e in await list_events(db.pool, id)] == ["a"]

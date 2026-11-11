from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import asyncpg
import pytest

from app.db.repos.outbox import claim_due_outbox, insert_outbox, list_outbox, save_outbox
from app.db.repos.records import insert_record
from app.db.tx import transaction
from tests.repos.seed import HASH, barrier, seed_session

T0 = datetime(2026, 11, 8, 12, 0, tzinfo=UTC)


def at(seconds: int) -> datetime:
    return T0 + timedelta(seconds=seconds)


async def session_with_record(pool: asyncpg.Pool, revisions: int = 1) -> str:
    id = await seed_session(pool)
    for revision in range(1, revisions + 1):
        await insert_record(pool, session_id=id, revision=revision, outcome="completed", payload={}, content_hash=HASH)
    return id


async def test_insert_outbox_queues_a_pending_delivery_for_an_existing_revision(db) -> None:
    id = await session_with_record(db.pool)
    row = await insert_outbox(db.pool, session_id=id, revision=1, target="webhook")
    assert (row.session_id, row.revision, row.target, row.status, row.attempts, row.last_error, row.delivered_at) == (
        id,
        1,
        "webhook",
        "pending",
        0,
        None,
        None,
    )
    assert isinstance(row.id, int)
    assert isinstance(row.next_attempt_at, datetime)
    with pytest.raises(asyncpg.PostgresError) as err:
        await insert_outbox(db.pool, session_id=id, revision=1, target="webhook")
    assert err.value.sqlstate == "23505"
    with pytest.raises(asyncpg.PostgresError) as err:
        await insert_outbox(db.pool, session_id=id, revision=9, target="webhook")
    assert err.value.sqlstate == "23503"


async def test_save_outbox_writes_the_delivery_state_none_for_an_unknown_id(db) -> None:
    id = await session_with_record(db.pool)
    row = await insert_outbox(db.pool, session_id=id, revision=1, target="webhook", next_attempt_at=T0)
    failed = await save_outbox(
        db.pool,
        id=row.id,
        status="sending",
        attempts=1,
        next_attempt_at=at(30),
        last_error="HTTP 503",
        delivered_at=None,
    )
    assert failed is not None
    assert (failed.status, failed.attempts, failed.next_attempt_at, failed.last_error, failed.delivered_at) == (
        "sending",
        1,
        at(30),
        "HTTP 503",
        None,
    )
    done = await save_outbox(
        db.pool, id=row.id, status="delivered", attempts=2, next_attempt_at=at(30), last_error=None, delivered_at=at(31)
    )
    assert done is not None
    assert (done.status, done.attempts, done.last_error, done.delivered_at) == ("delivered", 2, None, at(31))
    missing = await save_outbox(
        db.pool, id=987654321, status="dead", attempts=1, next_attempt_at=T0, last_error=None, delivered_at=None
    )
    assert missing is None


async def test_list_outbox_returns_the_sessions_rows_by_revision_and_target(db) -> None:
    id = await session_with_record(db.pool, 2)
    await insert_outbox(db.pool, session_id=id, revision=2, target="webhook")
    await insert_outbox(db.pool, session_id=id, revision=1, target="webhook")
    await insert_outbox(db.pool, session_id=id, revision=1, target="console")
    assert [f"{r.revision}:{r.target}" for r in await list_outbox(db.pool, id)] == [
        "1:console",
        "1:webhook",
        "2:webhook",
    ]


async def test_claim_due_outbox_returns_due_pending_sending_rows_oldest_first_never_delivered_dead_or_future(
    db,
) -> None:
    id = await session_with_record(db.pool)
    for target, due, status in (
        ("a", -30, "pending"),
        ("b", -60, "sending"),
        ("c", -90, "delivered"),
        ("d", -90, "dead"),
        ("e", 30, "pending"),
    ):
        row = await insert_outbox(db.pool, session_id=id, revision=1, target=target, next_attempt_at=at(due))
        if status != "pending":
            await save_outbox(
                db.pool,
                id=row.id,
                status=status,
                attempts=row.attempts,
                next_attempt_at=row.next_attempt_at,
                last_error=row.last_error,
                delivered_at=None,
            )
    async with transaction(db.pool) as tx:
        assert [r.target for r in await claim_due_outbox(tx, now=T0, limit=10)] == ["b", "a"]
    async with transaction(db.pool) as tx:
        assert [r.target for r in await claim_due_outbox(tx, now=T0, limit=1)] == ["b"]
    with pytest.raises(ValueError):
        async with transaction(db.pool) as tx:
            await claim_due_outbox(tx, now=T0, limit=1.5)  # type: ignore[arg-type]


async def test_skip_locked_concurrent_claimers_two_pools_never_get_the_same_row(db, schema) -> None:
    due: list[int] = []
    # One row per session: a session's later revisions wait for its earlier ones.
    for i in range(12):
        id = await session_with_record(db.pool, 1)
        due.append(
            (await insert_outbox(db.pool, session_id=id, revision=1, target="webhook", next_attempt_at=at(-1 - i))).id
        )
    other_instance = await schema.open(max_size=4)
    try:
        all_claimed = barrier(6)

        async def claim(pool: asyncpg.Pool) -> list[int]:
            async with transaction(pool) as tx:
                claimed = await claim_due_outbox(tx, now=T0, limit=2)
                await all_claimed()
                return [r.id for r in claimed]

        claims = await asyncio.gather(*(claim(db.pool if i % 2 == 0 else other_instance.pool) for i in range(6)))
    finally:
        await other_instance.close()
    flat = [x for claim_ids in claims for x in claim_ids]
    assert len(set(flat)) == len(flat)
    assert sorted(flat) == sorted(due)

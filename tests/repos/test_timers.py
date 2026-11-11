from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from app.db.repos.timers import (
    Timer,
    claim_due_timers,
    count_overdue_timers,
    delete_timer,
    earliest_timer_due_at,
    list_timers,
    upsert_timer,
)
from app.db.tx import transaction
from tests.repos.seed import barrier, seed_session

T0 = datetime(2026, 11, 8, 12, 0, tzinfo=UTC)


def at(seconds: int) -> datetime:
    return T0 + timedelta(seconds=seconds)


def key(timer: Timer) -> str:
    return f"{timer.session_id}/{timer.kind}"


async def test_upsert_timer_sets_a_timer_and_moves_it_on_a_second_call(db) -> None:
    id = await seed_session(db.pool)
    assert await upsert_timer(db.pool, Timer(id, "idle", at(60))) == Timer(id, "idle", at(60))
    assert await upsert_timer(db.pool, Timer(id, "idle", at(120))) == Timer(id, "idle", at(120))
    assert await list_timers(db.pool, id) == [Timer(id, "idle", at(120))]


async def test_list_timers_returns_the_sessions_timers_earliest_first(db) -> None:
    id = await seed_session(db.pool)
    await upsert_timer(db.pool, Timer(id, "sessionExpiry", at(600)))
    await upsert_timer(db.pool, Timer(id, "idle", at(60)))
    assert [t.kind for t in await list_timers(db.pool, id)] == ["idle", "sessionExpiry"]
    assert await list_timers(db.pool, await seed_session(db.pool)) == []


async def test_delete_timer_removes_a_timer_and_reports_whether_one_existed(db) -> None:
    id = await seed_session(db.pool)
    await upsert_timer(db.pool, Timer(id, "idle", at(60)))
    assert await delete_timer(db.pool, id, "idle") is True
    assert await delete_timer(db.pool, id, "idle") is False
    assert await list_timers(db.pool, id) == []


async def test_earliest_timer_due_at_is_the_minimum_across_sessions_or_none_with_no_timers(db) -> None:
    assert await earliest_timer_due_at(db.pool) is None
    await upsert_timer(db.pool, Timer(await seed_session(db.pool), "idle", at(300)))
    await upsert_timer(db.pool, Timer(await seed_session(db.pool), "noCallStart", at(30)))
    assert await earliest_timer_due_at(db.pool) == at(30)


async def test_count_overdue_timers_counts_only_timers_due_now(db) -> None:
    assert await count_overdue_timers(db.pool) == 0
    now = datetime.now(UTC)
    await upsert_timer(db.pool, Timer(await seed_session(db.pool), "idle", now - timedelta(seconds=5)))
    await upsert_timer(db.pool, Timer(await seed_session(db.pool), "idle", now + timedelta(hours=1)))
    assert await count_overdue_timers(db.pool) == 1


async def test_claim_due_timers_returns_only_due_timers_earliest_first_up_to_the_limit(db) -> None:
    id = await seed_session(db.pool)
    await upsert_timer(db.pool, Timer(id, "idle", at(-10)))
    await upsert_timer(db.pool, Timer(id, "noCallStart", at(-20)))
    await upsert_timer(db.pool, Timer(id, "sessionExpiry", at(10)))
    async with transaction(db.pool) as tx:
        assert [t.kind for t in await claim_due_timers(tx, now=T0, limit=10)] == ["noCallStart", "idle"]
    async with transaction(db.pool) as tx:
        assert [t.kind for t in await claim_due_timers(tx, now=T0, limit=1)] == ["noCallStart"]
    with pytest.raises(ValueError):
        async with transaction(db.pool) as tx:
            await claim_due_timers(tx, now=T0, limit=0)


async def test_skip_locked_concurrent_claimers_two_pools_never_get_the_same_timer(db, schema) -> None:
    due: list[str] = []
    for i in range(12):
        timer = await upsert_timer(db.pool, Timer(await seed_session(db.pool), "idle", at(-i)))
        due.append(key(timer))
    await upsert_timer(db.pool, Timer(await seed_session(db.pool), "idle", at(5)))  # not due
    other_instance = await schema.open(max_size=4)
    try:
        all_claimed = barrier(6)

        async def claim(pool) -> list[str]:  # type: ignore[no-untyped-def]
            async with transaction(pool) as tx:
                claimed = await claim_due_timers(tx, now=T0, limit=3)
                await all_claimed()  # every claimer holds its claim until all six have claimed
                return [key(t) for t in claimed]

        claims = await asyncio.gather(*(claim(db.pool if i % 2 == 0 else other_instance.pool) for i in range(6)))
    finally:
        await other_instance.close()
    flat = [x for c in claims for x in c]
    assert len(set(flat)) == len(flat)  # no timer handed to two claimers
    assert sorted(flat) == sorted(due)  # and every due timer was claimed once


async def test_a_claim_lasts_until_its_transaction_ends_then_the_row_is_claimable_again(db) -> None:
    await upsert_timer(db.pool, Timer(await seed_session(db.pool), "idle", at(-1)))
    release = asyncio.Event()
    holding = asyncio.Event()

    async def first() -> int:
        async with transaction(db.pool) as tx:
            claimed = await claim_due_timers(tx, now=T0, limit=5)
            holding.set()
            await release.wait()
            return len(claimed)

    task = asyncio.create_task(first())
    await holding.wait()
    async with transaction(db.pool) as tx:
        assert await claim_due_timers(tx, now=T0, limit=5) == []
    release.set()
    assert await task == 1
    async with transaction(db.pool) as tx:
        assert len(await claim_due_timers(tx, now=T0, limit=5)) == 1

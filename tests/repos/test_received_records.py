from __future__ import annotations

import asyncio

from app.db.repos.received_records import list_received_records, upsert_received_record


async def test_upsert_received_record_stores_a_key_once_and_counts_repeats_keeping_the_first_payload(db) -> None:
    first = await upsert_received_record(db.pool, idempotency_key="s1:1", payload={"revision": 1, "n": "first"})
    assert (first.idempotency_key, first.payload, first.times_received) == ("s1:1", {"revision": 1, "n": "first"}, 1)
    await upsert_received_record(db.pool, idempotency_key="s1:1", payload={"revision": 1, "n": "second"})
    third = await upsert_received_record(db.pool, idempotency_key="s1:1", payload={"revision": 1, "n": "third"})
    assert third.times_received == 3
    assert third.payload == {"revision": 1, "n": "first"}
    assert third.first_received_at == first.first_received_at
    assert third.last_received_at >= first.last_received_at


async def test_concurrent_identical_deliveries_still_give_one_row_with_the_right_count(db) -> None:
    await asyncio.gather(*(upsert_received_record(db.pool, idempotency_key="s2:1", payload=[1, 2]) for _ in range(5)))
    row = next(r for r in await list_received_records(db.pool) if r.idempotency_key == "s2:1")
    assert (row.times_received, row.payload) == (5, [1, 2])


async def test_list_received_records_returns_every_stored_key_in_arrival_order(db) -> None:
    for key in ("s1:1", "s2:1", "s3:1"):
        await upsert_received_record(db.pool, idempotency_key=key, payload={})
    assert [r.idempotency_key for r in await list_received_records(db.pool)] == ["s1:1", "s2:1", "s3:1"]

from __future__ import annotations

from datetime import datetime
from typing import Any

import asyncpg
import pytest

from app.db.repos.records import get_latest_record, get_latest_revision_hash, get_record, insert_record, list_records
from tests.repos.seed import HASH, seed_session


def payload(revision: int) -> dict[str, Any]:
    return {"revision": revision, "fields": {"email": {"value": "a@b.co", "status": "valid"}}, "conflicts": []}


async def test_insert_record_stores_a_revision_the_same_revision_twice_is_rejected(db) -> None:
    id = await seed_session(db.pool)
    rec = await insert_record(
        db.pool, session_id=id, revision=1, outcome="partial", payload=payload(1), content_hash=HASH
    )
    assert (rec.session_id, rec.revision, rec.outcome, rec.payload, rec.content_hash) == (
        id,
        1,
        "partial",
        payload(1),
        HASH,
    )
    assert isinstance(rec.created_at, datetime)
    with pytest.raises(asyncpg.PostgresError) as err:
        await insert_record(
            db.pool, session_id=id, revision=1, outcome="completed", payload=payload(1), content_hash=HASH
        )
    assert err.value.sqlstate == "23505"
    assert err.value.constraint_name == "records_session_revision_key"


async def test_get_record_finds_a_revision_get_latest_record_the_highest_list_records_all_in_order(db) -> None:
    id = await seed_session(db.pool)
    assert await get_latest_record(db.pool, id) is None
    assert await get_latest_revision_hash(db.pool, id) is None
    assert await list_records(db.pool, id) == []
    for revision, outcome in ((1, "partial"), (2, "completed")):
        await insert_record(
            db.pool,
            session_id=id,
            revision=revision,
            outcome=outcome,
            payload=payload(revision),
            content_hash=str(revision) * 64,
        )
    first = await get_record(db.pool, id, 1)
    assert first is not None and first.outcome == "partial"
    assert await get_record(db.pool, id, 3) is None
    latest = await get_latest_record(db.pool, id)
    assert latest is not None and latest.revision == 2
    newest = await get_latest_revision_hash(db.pool, id)
    assert newest is not None and (newest.revision, newest.content_hash) == (2, "2" * 64)
    assert [r.revision for r in await list_records(db.pool, id)] == [1, 2]


async def test_records_are_immutable_updates_and_deletes_are_rejected(db) -> None:
    id = await seed_session(db.pool)
    await insert_record(db.pool, session_id=id, revision=1, outcome="partial", payload=payload(1), content_hash=HASH)
    for statement in ("UPDATE records SET outcome = 'completed'", "DELETE FROM records"):
        with pytest.raises(asyncpg.PostgresError) as err:
            await db.pool.execute(statement)
        assert err.value.sqlstate == "23001"
    assert len(await list_records(db.pool, id)) == 1

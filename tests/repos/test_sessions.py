from __future__ import annotations

import dataclasses
import uuid
from datetime import UTC, datetime

import asyncpg
import pytest

from app.db.repos.sessions import get_session, insert_session, list_active_session_ids, lock_session, save_session
from app.db.tx import transaction


async def test_insert_session_creates_a_session_with_defaults_and_returns_none_for_an_existing_id(db) -> None:
    id = str(uuid.uuid4())
    created = await insert_session(db.pool, id=id)
    assert created is not None
    assert (
        created.id,
        created.status,
        created.outcome,
        created.version,
        created.current_revision,
        created.language,
        created.active_call_id,
        created.open_request_id,
        created.review_flags,
    ) == (id, "active", None, 0, 0, "en", None, None, [])
    assert isinstance(created.created_at, datetime)
    assert isinstance(created.last_activity_at, datetime)
    assert await insert_session(db.pool, id=id, language="hi") is None
    existing = await get_session(db.pool, id)
    assert existing is not None and existing.language == "en"
    other = await insert_session(db.pool, id=str(uuid.uuid4()), language="hi")
    assert other is not None and other.language == "hi"


async def test_get_session_returns_the_row_or_none_for_an_unknown_id(db) -> None:
    id = str(uuid.uuid4())
    await insert_session(db.pool, id=id)
    found = await get_session(db.pool, id)
    assert found is not None and found.id == id
    assert await get_session(db.pool, str(uuid.uuid4())) is None


async def test_lock_session_returns_the_row_inside_a_transaction(db) -> None:
    id = str(uuid.uuid4())
    await insert_session(db.pool, id=id)
    async with transaction(db.pool) as tx:
        locked = await lock_session(tx, id)
    assert locked is not None and locked.status == "active"


async def test_save_session_writes_every_mutable_column_including_json_arrays_and_nulls(db) -> None:
    id = str(uuid.uuid4())
    loaded = await insert_session(db.pool, id=id)
    assert loaded is not None
    at = datetime(2026, 11, 8, 10, 0, tzinfo=UTC)
    changed = dataclasses.replace(
        loaded,
        status="finalized",
        outcome="needsReview",
        version=7,
        current_revision=2,
        language="hi",
        active_call_id="c_1",
        open_request_id="req_serial_1",
        review_flags=["R-1", {"rule": "R-2", "field": "email"}],
        last_activity_at=at,
    )
    assert await save_session(db.pool, changed) == changed
    assert await get_session(db.pool, id) == changed
    cleared = dataclasses.replace(changed, outcome=None, active_call_id=None, open_request_id=None, review_flags=[])
    assert await save_session(db.pool, cleared) == cleared


async def test_save_session_returns_none_for_an_unknown_id_the_database_rejects_invalid_values(db) -> None:
    id = str(uuid.uuid4())
    loaded = await insert_session(db.pool, id=id)
    assert loaded is not None
    assert await save_session(db.pool, dataclasses.replace(loaded, id=str(uuid.uuid4()))) is None
    with pytest.raises(asyncpg.PostgresError) as err:
        await save_session(db.pool, dataclasses.replace(loaded, status="bogus"))
    assert err.value.sqlstate == "23514"
    with pytest.raises(asyncpg.PostgresError) as err:
        await save_session(db.pool, dataclasses.replace(loaded, version=-1))
    assert err.value.sqlstate == "23514"


async def test_list_active_session_ids_most_recently_active_first(db) -> None:
    first, second = str(uuid.uuid4()), str(uuid.uuid4())
    for id in (first, second):
        await insert_session(db.pool, id=id)
    done = await get_session(db.pool, first)
    assert done is not None
    await save_session(db.pool, dataclasses.replace(done, last_activity_at=datetime(2030, 1, 1, tzinfo=UTC)))
    closed = str(uuid.uuid4())
    loaded = await insert_session(db.pool, id=closed)
    assert loaded is not None
    await save_session(db.pool, dataclasses.replace(loaded, status="closed"))
    assert await list_active_session_ids(db.pool) == [first, second]

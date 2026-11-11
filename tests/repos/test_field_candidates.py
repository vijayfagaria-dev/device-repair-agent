from __future__ import annotations

from datetime import UTC, datetime

import asyncpg
import pytest

from app.db.repos.field_candidates import insert_field_candidate, list_field_candidates
from tests.repos.seed import seed_event, seed_session


async def test_insert_field_candidate_stores_any_json_raw_value_with_defaults(db) -> None:
    id = await seed_session(db.pool)
    seq = await seed_event(db.pool, id)
    minimal = await insert_field_candidate(
        db.pool, session_id=id, event_seq=seq, field="serialNumber", source="call", raw="ab 12", status="unverified"
    )
    assert (
        minimal.session_id,
        minimal.event_seq,
        minimal.field,
        minimal.source,
        minimal.raw,
        minimal.normalized,
        minimal.status,
        minimal.error,
        minimal.user_confirmed,
        minimal.evidence,
    ) == (id, seq, "serialNumber", "call", "ab 12", None, "unverified", None, False, None)
    assert isinstance(minimal.id, int)
    assert isinstance(minimal.collected_at, datetime)

    at = datetime(2026, 11, 8, 9, 30, tzinfo=UTC)
    full = await insert_field_candidate(
        db.pool,
        session_id=id,
        event_seq=seq,
        field="photos",
        source="chat",
        raw=["file:a", "file:b"],
        normalized={"urls": ["file:a", "file:b"], "count": 2},
        status="invalid",
        error="too_many",
        user_confirmed=True,
        collected_at=at,
        evidence="user said two",
    )
    assert full.raw == ["file:a", "file:b"]
    assert full.normalized == {"urls": ["file:a", "file:b"], "count": 2}
    assert (full.error, full.user_confirmed, full.collected_at, full.evidence) == (
        "too_many",
        True,
        at,
        "user said two",
    )
    assert full.id > minimal.id


async def test_list_field_candidates_returns_all_candidates_or_one_fields_in_insertion_order(db) -> None:
    id = await seed_session(db.pool)
    seq = await seed_event(db.pool, id)
    for field, raw in (("email", "a@b.co"), ("phone", "+911234567890"), ("email", "c@d.co")):
        await insert_field_candidate(
            db.pool, session_id=id, event_seq=seq, field=field, source="chat", raw=raw, status="valid"
        )
    assert [c.raw for c in await list_field_candidates(db.pool, id)] == ["a@b.co", "+911234567890", "c@d.co"]
    assert [c.raw for c in await list_field_candidates(db.pool, id, "email")] == ["a@b.co", "c@d.co"]
    assert await list_field_candidates(db.pool, id, "nothing") == []


async def test_a_candidate_pointing_at_a_missing_event_is_rejected_outside_a_transaction(db) -> None:
    id = await seed_session(db.pool)
    with pytest.raises(asyncpg.PostgresError) as err:
        await insert_field_candidate(
            db.pool, session_id=id, event_seq=42, field="email", source="chat", raw="x", status="valid"
        )
    assert err.value.sqlstate == "23503"


async def test_field_candidates_are_append_only(db) -> None:
    id = await seed_session(db.pool)
    seq = await seed_event(db.pool, id)
    await insert_field_candidate(
        db.pool, session_id=id, event_seq=seq, field="email", source="chat", raw="x", status="valid"
    )
    for statement in (
        "UPDATE field_candidates SET status = 'invalid'",
        "DELETE FROM field_candidates",
        "TRUNCATE field_candidates",
    ):
        with pytest.raises(asyncpg.PostgresError) as err:
            await db.pool.execute(statement)
        assert err.value.sqlstate == "23001"

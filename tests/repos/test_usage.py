from __future__ import annotations

from datetime import UTC, datetime

import pytest

from app.db.repos.usage import insert_usage, list_usage
from tests.repos.seed import seed_session


async def test_insert_usage_stores_units_and_cost_as_numbers_cost_defaults_to_0_exact_to_8_decimals(db) -> None:
    id = await seed_session(db.pool)
    at = datetime(2026, 11, 8, 7, 0, tzinfo=UTC)
    entry = await insert_usage(
        db.pool, session_id=id, provider="groq", kind="llm.prompt", units=1234, unit="token", cost_usd=0.00012345, at=at
    )
    assert (entry.session_id, entry.provider, entry.kind, entry.units, entry.unit, entry.cost_usd, entry.at) == (
        id,
        "groq",
        "llm.prompt",
        1234,
        "token",
        0.00012345,
        at,
    )
    assert isinstance(entry.id, int)
    free = await insert_usage(db.pool, session_id=id, provider="deepgram", kind="stt", units=1.5, unit="minute")
    assert (free.units, free.cost_usd) == (1.5, 0)
    assert isinstance(free.at, datetime)


async def test_insert_usage_rejects_negative_or_non_finite_amounts_before_querying(db) -> None:
    id = await seed_session(db.pool)
    for bad in ({"units": -1}, {"units": float("nan")}, {"units": 1, "cost_usd": -0.01}, {"units": float("inf")}):
        with pytest.raises(ValueError):
            await insert_usage(db.pool, session_id=id, provider="p", kind="k", unit="u", **bad)  # type: ignore[arg-type]
    assert await list_usage(db.pool, id) == []


async def test_list_usage_returns_the_sessions_entries_in_time_order(db) -> None:
    id = await seed_session(db.pool)
    await insert_usage(
        db.pool, session_id=id, provider="b", kind="k", units=2, unit="u", at=datetime(2026, 11, 8, 7, 2, tzinfo=UTC)
    )
    await insert_usage(
        db.pool, session_id=id, provider="a", kind="k", units=1, unit="u", at=datetime(2026, 11, 8, 7, 1, tzinfo=UTC)
    )
    assert [u.provider for u in await list_usage(db.pool, id)] == ["a", "b"]
    assert await list_usage(db.pool, await seed_session(db.pool)) == []

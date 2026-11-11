from __future__ import annotations

from datetime import UTC, datetime

from app.db.repos.calls import insert_call
from app.db.repos.turn_metrics import TurnMetric, list_turn_metrics, upsert_turn_metric
from tests.repos.seed import seed_session


async def session_with_call(pool) -> dict[str, str]:  # type: ignore[no-untyped-def]
    session_id = await seed_session(pool)
    call = await insert_call(pool, id=f"c_{session_id}", session_id=session_id)
    return {"session_id": session_id, "call_id": call.id}


async def test_upsert_turn_metric_inserts_a_turn_then_merges_later_stages_without_erasing_earlier_ones(db) -> None:
    ids = await session_with_call(db.pool)
    user_end_at = datetime(2026, 11, 8, 10, 0, tzinfo=UTC)
    first = await upsert_turn_metric(
        db.pool, turn_id="ta_1", **ids, user_end_at=user_end_at, stt_ms=120, llm_ttft_ms=300
    )
    assert first == TurnMetric(
        turn_id="ta_1",
        **ids,
        user_end_at=user_end_at,
        first_audio_at=None,
        server_ms=None,
        client_ms=None,
        stt_ms=120,
        llm_ttft_ms=300,
        tts_ttfb_ms=None,
    )
    merged = await upsert_turn_metric(db.pool, turn_id="ta_1", **ids, client_ms=950, server_ms=800)
    assert merged is not None
    assert (merged.user_end_at, merged.stt_ms, merged.llm_ttft_ms, merged.client_ms, merged.server_ms) == (
        user_end_at,
        120,
        300,
        950,
        800,
    )


async def test_upsert_turn_metric_refuses_to_write_into_another_sessions_turn(db) -> None:
    owner = await session_with_call(db.pool)
    other = await session_with_call(db.pool)
    await upsert_turn_metric(db.pool, turn_id="ta_owned", **owner, client_ms=500)
    assert await upsert_turn_metric(db.pool, turn_id="ta_owned", **other, client_ms=1) is None
    assert (await list_turn_metrics(db.pool, owner["session_id"]))[0].client_ms == 500
    assert await list_turn_metrics(db.pool, other["session_id"]) == []


async def test_list_turn_metrics_returns_the_sessions_turns_in_time_order(db) -> None:
    ids = await session_with_call(db.pool)
    await upsert_turn_metric(db.pool, turn_id="ta_b", **ids, user_end_at=datetime(2026, 11, 8, 10, 0, 2, tzinfo=UTC))
    await upsert_turn_metric(db.pool, turn_id="ta_a", **ids, user_end_at=datetime(2026, 11, 8, 10, 0, 1, tzinfo=UTC))
    await upsert_turn_metric(db.pool, turn_id="ta_c", **ids)
    assert [t.turn_id for t in await list_turn_metrics(db.pool, ids["session_id"])] == ["ta_a", "ta_b", "ta_c"]

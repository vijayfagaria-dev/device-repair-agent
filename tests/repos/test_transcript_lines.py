from __future__ import annotations

from datetime import UTC, datetime

from app.db.repos.calls import insert_call
from app.db.repos.transcript_lines import TranscriptLine, insert_transcript_line, list_transcript_lines
from tests.repos.seed import seed_event, seed_session

AT = datetime(2026, 11, 8, 11, 0, tzinfo=UTC)


async def test_insert_transcript_line_stores_a_final_line_interrupted_defaults_to_false(db) -> None:
    id = await seed_session(db.pool)
    call = await insert_call(db.pool, id=f"c_{id}", session_id=id)
    seq = await seed_event(db.pool, id)
    line = await insert_transcript_line(
        db.pool,
        id=f"ta_{call.id}_1",
        session_id=id,
        call_id=call.id,
        event_seq=seq,
        role="agent",
        text="Hi, which device?",
        started_at=AT,
    )
    assert line == TranscriptLine(
        id=f"ta_{call.id}_1",
        session_id=id,
        call_id=call.id,
        event_seq=seq,
        role="agent",
        text="Hi, which device?",
        interrupted=False,
        started_at=AT,
    )
    cut = await insert_transcript_line(
        db.pool,
        id=f"ta_{call.id}_2",
        session_id=id,
        call_id=call.id,
        event_seq=seq,
        role="agent",
        text="So the",
        interrupted=True,
        started_at=AT,
    )
    assert cut.interrupted is True


async def test_list_transcript_lines_returns_the_sessions_lines_in_event_order(db) -> None:
    id = await seed_session(db.pool)
    call = await insert_call(db.pool, id=f"c_{id}", session_id=id)
    first = await seed_event(db.pool, id)
    second = await seed_event(db.pool, id)
    await insert_transcript_line(
        db.pool,
        id=f"tu_{call.id}_1",
        session_id=id,
        call_id=call.id,
        event_seq=second,
        role="user",
        text="a phone",
        started_at=AT,
    )
    await insert_transcript_line(
        db.pool,
        id=f"ta_{call.id}_1",
        session_id=id,
        call_id=call.id,
        event_seq=first,
        role="agent",
        text="Which device?",
        started_at=AT,
    )
    assert [line.text for line in await list_transcript_lines(db.pool, id)] == ["Which device?", "a phone"]
    assert await list_transcript_lines(db.pool, await seed_session(db.pool)) == []

"""turn_metrics: per-turn latency (D19). Stages arrive at different times (client_ms last, via clientMetric),
so writes merge into the row: a stage that is already recorded is kept unless a new value is given.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

import asyncpg

from app.db.tx import Queryable


@dataclass(frozen=True, slots=True)
class TurnMetric:
    turn_id: str
    session_id: str
    call_id: str
    user_end_at: datetime | None
    first_audio_at: datetime | None
    server_ms: int | None
    client_ms: int | None
    stt_ms: int | None
    llm_ttft_ms: int | None
    tts_ttfb_ms: int | None


COLUMNS = """turn_id AS "turnId", session_id AS "sessionId", call_id AS "callId", user_end_at AS "userEndAt",
  first_audio_at AS "firstAudioAt", server_ms AS "serverMs", client_ms AS "clientMs", stt_ms AS "sttMs",
  llm_ttft_ms AS "llmTtftMs", tts_ttfb_ms AS "ttsTtfbMs\""""


def _metric(row: asyncpg.Record) -> TurnMetric:
    return TurnMetric(
        turn_id=row["turnId"],
        session_id=row["sessionId"],
        call_id=row["callId"],
        user_end_at=row["userEndAt"],
        first_audio_at=row["firstAudioAt"],
        server_ms=row["serverMs"],
        client_ms=row["clientMs"],
        stt_ms=row["sttMs"],
        llm_ttft_ms=row["llmTtftMs"],
        tts_ttfb_ms=row["ttsTtfbMs"],
    )


async def upsert_turn_metric(
    db: Queryable,
    *,
    turn_id: str,
    session_id: str,
    call_id: str,
    user_end_at: datetime | None = None,
    first_audio_at: datetime | None = None,
    server_ms: int | None = None,
    client_ms: int | None = None,
    stt_ms: int | None = None,
    llm_ttft_ms: int | None = None,
    tts_ttfb_ms: int | None = None,
) -> TurnMetric | None:
    """
    Inserts the turn or merges the given stages into it. Returns None, changing nothing, when the turn id belongs to
    a different session or call (a client can't write metrics into someone else's turn).
    """
    row = await db.fetchrow(
        f"""INSERT INTO turn_metrics
       (turn_id, session_id, call_id, user_end_at, first_audio_at, server_ms, client_ms, stt_ms, llm_ttft_ms, tts_ttfb_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (turn_id) DO UPDATE SET
       user_end_at    = COALESCE(EXCLUDED.user_end_at, turn_metrics.user_end_at),
       first_audio_at = COALESCE(EXCLUDED.first_audio_at, turn_metrics.first_audio_at),
       server_ms      = COALESCE(EXCLUDED.server_ms, turn_metrics.server_ms),
       client_ms      = COALESCE(EXCLUDED.client_ms, turn_metrics.client_ms),
       stt_ms         = COALESCE(EXCLUDED.stt_ms, turn_metrics.stt_ms),
       llm_ttft_ms    = COALESCE(EXCLUDED.llm_ttft_ms, turn_metrics.llm_ttft_ms),
       tts_ttfb_ms    = COALESCE(EXCLUDED.tts_ttfb_ms, turn_metrics.tts_ttfb_ms)
     WHERE turn_metrics.session_id = EXCLUDED.session_id AND turn_metrics.call_id = EXCLUDED.call_id
     RETURNING {COLUMNS}""",
        turn_id,
        session_id,
        call_id,
        user_end_at,
        first_audio_at,
        server_ms,
        client_ms,
        stt_ms,
        llm_ttft_ms,
        tts_ttfb_ms,
    )
    return _metric(row) if row else None


async def list_turn_metrics(db: Queryable, session_id: str) -> list[TurnMetric]:
    rows = await db.fetch(
        f"SELECT {COLUMNS} FROM turn_metrics WHERE session_id = $1 ORDER BY user_end_at NULLS LAST, turn_id", session_id
    )
    return [_metric(r) for r in rows]

"""transcript_lines: final transcript lines of a call (interim text is never stored)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum

import asyncpg

from app.db.tx import Queryable

from .rows import enum_value


@dataclass(frozen=True, slots=True)
class TranscriptLine:
    id: str
    session_id: str
    call_id: str
    event_seq: int
    role: str
    text: str
    interrupted: bool
    started_at: datetime


COLUMNS = """id, session_id AS "sessionId", call_id AS "callId", event_seq AS "eventSeq", role, text, interrupted,
  started_at AS "startedAt\""""


def _line(row: asyncpg.Record) -> TranscriptLine:
    return TranscriptLine(
        id=row["id"],
        session_id=row["sessionId"],
        call_id=row["callId"],
        event_seq=row["eventSeq"],
        role=row["role"],
        text=row["text"],
        interrupted=row["interrupted"],
        started_at=row["startedAt"],
    )


async def insert_transcript_line(
    db: Queryable,
    *,
    id: str,
    session_id: str,
    call_id: str,
    event_seq: int,
    role: str | Enum,
    text: str,
    started_at: datetime,
    interrupted: bool = False,
) -> TranscriptLine:
    """`event_seq` is the transcript event; it may be appended later in the same transaction (deferred FK)."""
    row = await db.fetchrow(
        f"""INSERT INTO transcript_lines (id, session_id, call_id, event_seq, role, text, interrupted, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING {COLUMNS}""",
        id,
        session_id,
        call_id,
        event_seq,
        enum_value(role),
        text,
        interrupted,
        started_at,
    )
    assert row is not None
    return _line(row)


async def list_transcript_lines(db: Queryable, session_id: str) -> list[TranscriptLine]:
    """Lines of all of the session's calls, in event order (the replay order)."""
    rows = await db.fetch(
        f"SELECT {COLUMNS} FROM transcript_lines WHERE session_id = $1 ORDER BY event_seq, id", session_id
    )
    return [_line(r) for r in rows]

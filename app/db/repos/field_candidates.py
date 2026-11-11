"""field_candidates: every value ever offered for a field (D11, D15). Append-only: a correction is a new row."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Any

import asyncpg

from app.db.tx import Queryable

from .rows import big_id, enum_value

CANDIDATE_STATUSES = ("valid", "invalid", "skipped", "unverified")


@dataclass(frozen=True, slots=True)
class FieldCandidate:
    id: int
    session_id: str
    event_seq: int
    field: str
    source: str
    raw: Any
    normalized: Any
    status: str
    error: str | None
    user_confirmed: bool
    collected_at: datetime
    evidence: str | None


COLUMNS = """id, session_id AS "sessionId", event_seq AS "eventSeq", field, source, raw, normalized, status, error,
  user_confirmed AS "userConfirmed", collected_at AS "collectedAt", evidence"""


def _candidate(row: asyncpg.Record) -> FieldCandidate:
    return FieldCandidate(
        id=big_id(row["id"]),
        session_id=row["sessionId"],
        event_seq=row["eventSeq"],
        field=row["field"],
        source=row["source"],
        raw=row["raw"],
        normalized=row["normalized"],
        status=row["status"],
        error=row["error"],
        user_confirmed=row["userConfirmed"],
        collected_at=row["collectedAt"],
        evidence=row["evidence"],
    )


async def insert_field_candidate(
    db: Queryable,
    *,
    session_id: str,
    event_seq: int,
    field: str,
    source: str | Enum,
    raw: Any,
    status: str,
    normalized: Any = None,
    error: str | None = None,
    user_confirmed: bool = False,
    collected_at: datetime | None = None,
    evidence: str | None = None,
) -> FieldCandidate:
    """`event_seq` is the event that introduced the value; it may be appended later in the same transaction (deferred FK).

    `raw=None` is stored as JSON null (the column is NOT NULL: a skipped optional card answers null); `normalized=None`
    is stored as SQL NULL (as in the TS), never as JSON null.
    """
    row = await db.fetchrow(
        f"""INSERT INTO field_candidates
       (session_id, event_seq, field, source, raw, normalized, status, error, user_confirmed, collected_at, evidence)
     VALUES ($1, $2, $3, $4, COALESCE($5::jsonb, 'null'::jsonb), $6::jsonb, $7, $8, $9, COALESCE($10::timestamptz, now()), $11)
     RETURNING {COLUMNS}""",
        session_id,
        event_seq,
        field,
        enum_value(source),
        raw,
        normalized,
        status,
        error,
        user_confirmed,
        collected_at,
        evidence,
    )
    assert row is not None
    return _candidate(row)


async def list_field_candidates(db: Queryable, session_id: str, field: str | None = None) -> list[FieldCandidate]:
    """Candidates in insertion order: all fields, or one field."""
    rows = await db.fetch(
        f"SELECT {COLUMNS} FROM field_candidates WHERE session_id = $1 AND ($2::text IS NULL OR field = $2) ORDER BY id",
        session_id,
        field,
    )
    return [_candidate(r) for r in rows]

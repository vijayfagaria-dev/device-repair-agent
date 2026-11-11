"""calls: voice calls. At most one active (not ended) call per session (partial unique index; close code 4409)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

import asyncpg

from app.db.tx import Queryable


@dataclass(frozen=True, slots=True)
class Call:
    id: str
    session_id: str
    started_at: datetime
    ended_at: datetime | None
    end_reason: str | None


@dataclass(frozen=True, slots=True)
class ActiveCallPointer:
    session_id: str
    call_id: str


COLUMNS = (
    """id, session_id AS "sessionId", started_at AS "startedAt", ended_at AS "endedAt", end_reason AS "endReason\""""
)


def _call(row: asyncpg.Record) -> Call:
    return Call(
        id=row["id"],
        session_id=row["sessionId"],
        started_at=row["startedAt"],
        ended_at=row["endedAt"],
        end_reason=row["endReason"],
    )


async def insert_call(db: Queryable, *, id: str, session_id: str, started_at: datetime | None = None) -> Call:
    """Starts a call. Fails with 23505 (calls_one_active_idx) if the session already has an active call."""
    row = await db.fetchrow(
        f"""INSERT INTO calls (id, session_id, started_at) VALUES ($1, $2, COALESCE($3::timestamptz, now()))
     RETURNING {COLUMNS}""",
        id,
        session_id,
        started_at,
    )
    assert row is not None
    return _call(row)


async def get_call(db: Queryable, id: str) -> Call | None:
    row = await db.fetchrow(f"SELECT {COLUMNS} FROM calls WHERE id = $1", id)
    return _call(row) if row else None


async def get_active_call(db: Queryable, session_id: str) -> Call | None:
    row = await db.fetchrow(f"SELECT {COLUMNS} FROM calls WHERE session_id = $1 AND ended_at IS NULL", session_id)
    return _call(row) if row else None


async def end_call(db: Queryable, *, id: str, reason: str, ended_at: datetime | None = None) -> Call | None:
    """Ends an active call. Returns None if the call doesn't exist or has already ended (the first end wins)."""
    row = await db.fetchrow(
        f"""UPDATE calls SET ended_at = COALESCE($2::timestamptz, now()), end_reason = $3 WHERE id = $1 AND ended_at IS NULL
     RETURNING {COLUMNS}""",
        id,
        ended_at,
        reason,
    )
    return _call(row) if row else None


async def list_open_calls(db: Queryable) -> list[Call]:
    """Calls with no end: after a clean run there is at most one per session; after a crash they are what recovery closes."""
    rows = await db.fetch(f"SELECT {COLUMNS} FROM calls WHERE ended_at IS NULL ORDER BY started_at, id")
    return [_call(r) for r in rows]


async def list_active_call_pointers(db: Queryable) -> list[ActiveCallPointer]:
    """(session, call) pairs where a session still points at a call: recovery ends them even if the call row says it ended."""
    rows = await db.fetch(
        """SELECT id AS "sessionId", active_call_id AS "callId" FROM sessions WHERE active_call_id IS NOT NULL"""
    )
    return [ActiveCallPointer(session_id=r["sessionId"], call_id=r["callId"]) for r in rows]


async def list_calls(db: Queryable, session_id: str) -> list[Call]:
    """The session's calls, oldest first (engagement and the chat planner's mode)."""
    rows = await db.fetch(f"SELECT {COLUMNS} FROM calls WHERE session_id = $1 ORDER BY started_at, id", session_id)
    return [_call(r) for r in rows]

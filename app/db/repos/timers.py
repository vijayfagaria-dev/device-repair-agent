"""timers: persisted business deadlines (D16), one per kind per session."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

import asyncpg

from app.db.tx import Queryable, Tx

from .rows import affected, check_limit

TIMER_KINDS = ("idle", "noCallStart", "orphanUploads", "sessionExpiry")


@dataclass(frozen=True, slots=True)
class Timer:
    session_id: str
    kind: str
    due_at: datetime


COLUMNS = """session_id AS "sessionId", kind, due_at AS "dueAt\""""


def _timer(row: asyncpg.Record) -> Timer:
    return Timer(session_id=row["sessionId"], kind=row["kind"], due_at=row["dueAt"])


async def count_overdue_timers(db: Queryable) -> int:
    """How many timers are overdue right now (the boot recovery count; the sweeper fires them)."""
    return int(await db.fetchval("SELECT count(*)::int AS n FROM timers WHERE due_at <= now()") or 0)


async def upsert_timer(db: Queryable, timer: Timer) -> Timer:
    """Sets (or moves) the session's timer of this kind."""
    row = await db.fetchrow(
        f"""INSERT INTO timers (session_id, kind, due_at) VALUES ($1, $2, $3)
     ON CONFLICT (session_id, kind) DO UPDATE SET due_at = EXCLUDED.due_at
     RETURNING {COLUMNS}""",
        timer.session_id,
        timer.kind,
        timer.due_at,
    )
    assert row is not None
    return _timer(row)


async def delete_timer(db: Queryable, session_id: str, kind: str) -> bool:
    """Removes the timer; True if one existed."""
    status = await db.execute("DELETE FROM timers WHERE session_id = $1 AND kind = $2", session_id, kind)
    return affected(status) == 1


async def list_timers(db: Queryable, session_id: str) -> list[Timer]:
    rows = await db.fetch(f"SELECT {COLUMNS} FROM timers WHERE session_id = $1 ORDER BY due_at, kind", session_id)
    return [_timer(r) for r in rows]


async def earliest_timer_due_at(db: Queryable) -> datetime | None:
    """The earliest due time across all sessions (None when there are no timers); the sweeper sleeps until it."""
    return await db.fetchval('SELECT min(due_at) AS "dueAt" FROM timers')


async def claim_due_timers(tx: Tx, *, now: datetime, limit: int) -> list[Timer]:
    """
    Locks and returns timers due at `now`, earliest first. Rows another transaction has claimed are skipped
    (FOR UPDATE SKIP LOCKED), so concurrent claimers, also in different processes, never get the same timer.
    The claim lasts until the transaction ends.
    """
    rows = await tx.fetch(
        f"SELECT {COLUMNS} FROM timers WHERE due_at <= $1 ORDER BY due_at, session_id, kind LIMIT $2 FOR UPDATE SKIP LOCKED",
        now,
        check_limit(limit),
    )
    return [_timer(r) for r in rows]

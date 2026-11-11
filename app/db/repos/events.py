"""events: the append-only session timeline (D12). seq is per session, consecutive from 1."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

import asyncpg

from app.db.tx import Queryable, Tx

EVENT_CHANNELS = ("call", "chat", "system")


@dataclass(frozen=True, slots=True)
class SessionEvent:
    session_id: str
    seq: int
    type: str
    channel: str
    payload: dict[str, Any]
    created_at: datetime


COLUMNS = """session_id AS "sessionId", seq, type, channel, payload, created_at AS "createdAt\""""


def _event(row: asyncpg.Record) -> SessionEvent:
    return SessionEvent(
        session_id=row["sessionId"],
        seq=row["seq"],
        type=row["type"],
        channel=row["channel"],
        payload=row["payload"],
        created_at=row["createdAt"],
    )


async def next_event_seq(tx: Tx, session_id: str) -> int:
    """
    The next seq for a session. Only correct while the transaction holds the session lock (lock_session): two
    unlocked callers would compute the same value, and the second insert would fail on UNIQUE(session_id, seq).
    """
    seq = await tx.fetchval(
        "SELECT COALESCE(max(seq), 0)::int + 1 AS seq FROM events WHERE session_id = $1", session_id
    )
    return int(seq)


async def append_event(
    tx: Tx,
    *,
    session_id: str,
    type: str,
    channel: str,
    payload: dict[str, Any] | None = None,
    seq: int | None = None,
) -> SessionEvent:
    """Appends an event at the next seq (or the given one, from next_event_seq, for deferred FKs). Needs the session lock."""
    if seq is None:
        seq = await next_event_seq(tx, session_id)
    row = await tx.fetchrow(
        f"""INSERT INTO events (session_id, seq, type, channel, payload) VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING {COLUMNS}""",
        session_id,
        seq,
        type,
        channel,
        {} if payload is None else payload,
    )
    assert row is not None
    return _event(row)


async def list_events(db: Queryable, session_id: str, *, after_seq: int = 0) -> list[SessionEvent]:
    """Events in seq order, optionally only those after a known seq."""
    rows = await db.fetch(
        f"SELECT {COLUMNS} FROM events WHERE session_id = $1 AND seq > $2 ORDER BY seq", session_id, after_seq
    )
    return [_event(r) for r in rows]

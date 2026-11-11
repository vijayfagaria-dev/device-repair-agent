"""chat_messages: agent and user chat messages, replayed in event order (protocol.md section 4)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum

import asyncpg

from app.db.tx import Queryable

from .rows import enum_value


@dataclass(frozen=True, slots=True)
class StoredChatMessage:
    id: str
    session_id: str
    event_seq: int
    role: str
    text: str
    request_id: str | None
    created_at: datetime


COLUMNS = """id, session_id AS "sessionId", event_seq AS "eventSeq", role, text, request_id AS "requestId",
  created_at AS "createdAt\""""


def _message(row: asyncpg.Record) -> StoredChatMessage:
    return StoredChatMessage(
        id=row["id"],
        session_id=row["sessionId"],
        event_seq=row["eventSeq"],
        role=row["role"],
        text=row["text"],
        request_id=row["requestId"],
        created_at=row["createdAt"],
    )


async def insert_chat_message(
    db: Queryable,
    *,
    id: str,
    session_id: str,
    event_seq: int,
    role: str | Enum,
    text: str,
    request_id: str | None = None,
) -> StoredChatMessage:
    """`event_seq` is the `chat.message` event; it may be appended later in the same transaction (deferred FK)."""
    row = await db.fetchrow(
        f"""INSERT INTO chat_messages (id, session_id, event_seq, role, text, request_id) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING {COLUMNS}""",
        id,
        session_id,
        event_seq,
        enum_value(role),
        text,
        request_id,
    )
    assert row is not None
    return _message(row)


async def list_chat_messages(db: Queryable, session_id: str) -> list[StoredChatMessage]:
    """Messages in event order (the replay order)."""
    rows = await db.fetch(
        f"SELECT {COLUMNS} FROM chat_messages WHERE session_id = $1 ORDER BY event_seq, id", session_id
    )
    return [_message(r) for r in rows]

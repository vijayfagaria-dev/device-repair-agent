"""input_requests: chat input cards (D13). At most one open card per session (partial unique index)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

import asyncpg

from app.db.tx import Queryable

INPUT_REQUEST_STATUSES = ("queued", "open", "answered", "cancelled")


@dataclass(frozen=True, slots=True)
class StoredInputRequest:
    session_id: str
    id: str
    field: str
    spec: dict[str, Any]
    status: str
    attempts: int
    created_at: datetime
    updated_at: datetime


COLUMNS = """session_id AS "sessionId", id, field, spec, status, attempts, created_at AS "createdAt",
  updated_at AS "updatedAt\""""


def _request(row: asyncpg.Record) -> StoredInputRequest:
    return StoredInputRequest(
        session_id=row["sessionId"],
        id=row["id"],
        field=row["field"],
        spec=row["spec"],
        status=row["status"],
        attempts=row["attempts"],
        created_at=row["createdAt"],
        updated_at=row["updatedAt"],
    )


async def insert_input_request(
    db: Queryable, *, session_id: str, id: str, field: str, spec: dict[str, Any], status: str = "queued"
) -> StoredInputRequest:
    row = await db.fetchrow(
        f"""INSERT INTO input_requests (session_id, id, field, spec, status) VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING {COLUMNS}""",
        session_id,
        id,
        field,
        spec,
        status,
    )
    assert row is not None
    return _request(row)


async def get_input_request(db: Queryable, session_id: str, id: str) -> StoredInputRequest | None:
    row = await db.fetchrow(f"SELECT {COLUMNS} FROM input_requests WHERE session_id = $1 AND id = $2", session_id, id)
    return _request(row) if row else None


async def get_open_input_request(db: Queryable, session_id: str) -> StoredInputRequest | None:
    row = await db.fetchrow(
        f"SELECT {COLUMNS} FROM input_requests WHERE session_id = $1 AND status = 'open'", session_id
    )
    return _request(row) if row else None


async def list_input_requests(db: Queryable, session_id: str) -> list[StoredInputRequest]:
    rows = await db.fetch(
        f"SELECT {COLUMNS} FROM input_requests WHERE session_id = $1 ORDER BY created_at, id", session_id
    )
    return [_request(r) for r in rows]


async def save_input_request(
    db: Queryable, *, session_id: str, id: str, status: str, attempts: int
) -> StoredInputRequest | None:
    """Updates status and attempts (and updated_at). Returns the stored row, or None if there is no such request."""
    row = await db.fetchrow(
        f"""UPDATE input_requests SET status = $3, attempts = $4, updated_at = now() WHERE session_id = $1 AND id = $2
     RETURNING {COLUMNS}""",
        session_id,
        id,
        status,
        attempts,
    )
    return _request(row) if row else None

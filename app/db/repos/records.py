"""records: immutable record revisions (D17). Append-only (trigger); a new revision is a new row."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Any

import asyncpg

from app.db.tx import Queryable

from .rows import enum_value


@dataclass(frozen=True, slots=True)
class StoredRecord:
    session_id: str
    revision: int
    outcome: str
    payload: dict[str, Any]
    content_hash: str
    created_at: datetime


@dataclass(frozen=True, slots=True)
class RevisionHash:
    revision: int
    content_hash: str


COLUMNS = """session_id AS "sessionId", revision, outcome, payload, content_hash AS "contentHash", created_at AS "createdAt\""""


def _record(row: asyncpg.Record) -> StoredRecord:
    return StoredRecord(
        session_id=row["sessionId"],
        revision=row["revision"],
        outcome=row["outcome"],
        payload=row["payload"],
        content_hash=row["contentHash"],
        created_at=row["createdAt"],
    )


async def insert_record(
    db: Queryable, *, session_id: str, revision: int, outcome: str | Enum, payload: dict[str, Any], content_hash: str
) -> StoredRecord:
    """Fails with 23505 (records_session_revision_key) if the revision already exists. `content_hash`: lowercase hex SHA-256."""
    row = await db.fetchrow(
        f"""INSERT INTO records (session_id, revision, outcome, payload, content_hash) VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING {COLUMNS}""",
        session_id,
        revision,
        enum_value(outcome),
        payload,
        content_hash,
    )
    assert row is not None
    return _record(row)


async def get_record(db: Queryable, session_id: str, revision: int) -> StoredRecord | None:
    row = await db.fetchrow(
        f"SELECT {COLUMNS} FROM records WHERE session_id = $1 AND revision = $2", session_id, revision
    )
    return _record(row) if row else None


async def get_latest_record(db: Queryable, session_id: str) -> StoredRecord | None:
    row = await db.fetchrow(
        f"SELECT {COLUMNS} FROM records WHERE session_id = $1 ORDER BY revision DESC LIMIT 1", session_id
    )
    return _record(row) if row else None


async def get_latest_revision_hash(db: Queryable, session_id: str) -> RevisionHash | None:
    """The latest revision's number and content hash, without its payload (the dedup check, D17)."""
    row = await db.fetchrow(
        """SELECT revision, content_hash AS "contentHash" FROM records WHERE session_id = $1 ORDER BY revision DESC LIMIT 1""",
        session_id,
    )
    return RevisionHash(revision=int(row["revision"]), content_hash=row["contentHash"]) if row else None


async def list_records(db: Queryable, session_id: str) -> list[StoredRecord]:
    rows = await db.fetch(f"SELECT {COLUMNS} FROM records WHERE session_id = $1 ORDER BY revision", session_id)
    return [_record(r) for r in rows]

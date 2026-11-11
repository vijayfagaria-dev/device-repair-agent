"""files + file_blobs: uploaded files (D10). Metadata and bytes are separate tables, written together."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import asyncpg

from app.db.tx import Queryable, Tx

from .rows import affected

FILE_MIME_TYPES = ("application/pdf", "image/jpeg", "image/png", "image/webp")


@dataclass(frozen=True, slots=True)
class StoredFile:
    id: str
    session_id: str
    mime: str
    size: int
    sha256: str
    original_name: str | None
    check_result: dict[str, Any] | None
    created_at: datetime


COLUMNS = """id, session_id AS "sessionId", mime, size, sha256, original_name AS "originalName",
  check_result AS "checkResult", created_at AS "createdAt\""""


def _file(row: asyncpg.Record) -> StoredFile:
    return StoredFile(
        id=row["id"],
        session_id=row["sessionId"],
        mime=row["mime"],
        size=row["size"],
        sha256=row["sha256"],
        original_name=row["originalName"],
        check_result=row["checkResult"],
        created_at=row["createdAt"],
    )


async def insert_file(
    tx: Tx,
    *,
    id: str,
    session_id: str,
    mime: str,
    data: bytes,
    original_name: str | None = None,
    check_result: dict[str, Any] | None = None,
) -> StoredFile:
    """
    Stores metadata and bytes in the caller's transaction, so neither exists without the other. Size and SHA-256
    are computed from the bytes here, so they always match what is stored. `mime` is the sniffed type (never the
    client's claim). (TS `bytes` is `data` here: `bytes` is a Python builtin.)
    """
    sha256 = hashlib.sha256(data).hexdigest()
    row = await tx.fetchrow(
        f"""INSERT INTO files (id, session_id, mime, size, sha256, original_name, check_result)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING {COLUMNS}""",
        id,
        session_id,
        mime,
        len(data),
        sha256,
        original_name,
        check_result,
    )
    assert row is not None
    await tx.execute("INSERT INTO file_blobs (file_id, bytes) VALUES ($1, $2)", id, data)
    return _file(row)


async def get_file(db: Queryable, id: str) -> StoredFile | None:
    """Metadata only (never reads the blob)."""
    row = await db.fetchrow(f"SELECT {COLUMNS} FROM files WHERE id = $1", id)
    return _file(row) if row else None


async def get_file_bytes(db: Queryable, id: str) -> bytes | None:
    row = await db.fetchrow("SELECT bytes FROM file_blobs WHERE file_id = $1", id)
    return bytes(row["bytes"]) if row else None


async def delete_orphan_files(db: Queryable, older_than: datetime) -> int:
    """
    Deletes uploads nothing refers to: older than `older_than` and named by no answer (candidate) of their session. An
    upload that was never submitted only uses the free-tier storage budget (D10). Bytes go with the row (ON DELETE CASCADE).
    A file a record carries is always named by a candidate, so records never lose a file.
    """
    status = await db.execute(
        """DELETE FROM files f
     WHERE f.created_at < $1
       AND NOT EXISTS (
         SELECT 1 FROM field_candidates c
         WHERE c.session_id = f.session_id AND position(f.id in c.normalized::text) > 0
       )""",
        older_than,
    )
    return affected(status)


async def list_files(db: Queryable, session_id: str) -> list[StoredFile]:
    """The session's files (metadata only), oldest first."""
    rows = await db.fetch(f"SELECT {COLUMNS} FROM files WHERE session_id = $1 ORDER BY created_at, id", session_id)
    return [_file(r) for r in rows]

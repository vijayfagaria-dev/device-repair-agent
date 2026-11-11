"""Upload storage (D10, P4-T03): file metadata (`files`) and bytes (`file_blobs`) in Postgres, written in one
transaction, within a global upload budget (default 600 MB, keeping headroom in Neon's 1 GB) and a per-session cap.
The budget check and the insert happen under one transaction-scoped advisory lock (it works through Neon's pooler,
D09), so concurrent uploads, also on two instances during a deploy, can't together overshoot either limit.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import asyncpg

from app.db.repos.files import StoredFile, get_file, get_file_bytes, insert_file
from app.db.tx import transaction

#: D10: at most 12 files per session (protocol.md section 7).
MAX_FILES_PER_SESSION = 12
#: UPLOAD_BUDGET_BYTES default (D10).
DEFAULT_UPLOAD_BUDGET_BYTES = 600 * 1024 * 1024
#: Serializes upload inserts: the budget is a sum over every session's files. ("upld" in ASCII.)
UPLOAD_LOCK_KEY = 0x75706C64


@dataclass(frozen=True, slots=True)
class NewUpload:
    id: str
    session_id: str
    #: The sniffed type (never the client's claim).
    mime: str
    data: bytes
    original_name: str | None


@dataclass(frozen=True, slots=True)
class StoreResult:
    """`ok` with `file`, or not `ok` with `reason` ("tooManyFiles" or "budget")."""

    ok: bool
    file: StoredFile | None = None
    reason: Literal["tooManyFiles", "budget"] | None = None


async def store_upload(pool: asyncpg.Pool, upload: NewUpload, *, budget_bytes: int) -> StoreResult:
    async with transaction(pool) as tx:
        await tx.execute("SELECT pg_advisory_xact_lock($1)", UPLOAD_LOCK_KEY)
        row = await tx.fetchrow(
            "SELECT COALESCE(sum(size), 0)::text AS total, count(*) FILTER (WHERE session_id = $1)::int AS mine FROM files",
            upload.session_id,
        )
        used = int(row["total"]) if row else 0
        mine = int(row["mine"]) if row else 0
        if mine >= MAX_FILES_PER_SESSION:
            return StoreResult(ok=False, reason="tooManyFiles")
        if used + len(upload.data) > budget_bytes:
            return StoreResult(ok=False, reason="budget")
        file = await insert_file(
            tx,
            id=upload.id,
            session_id=upload.session_id,
            mime=upload.mime,
            data=upload.data,
            original_name=upload.original_name,
        )
        return StoreResult(ok=True, file=file)


@dataclass(frozen=True, slots=True)
class StoredFileWithBytes:
    file: StoredFile
    data: bytes


async def read_stored_file(pool: asyncpg.Pool, file_id: str) -> StoredFileWithBytes | None:
    """Metadata and bytes of one stored file, or None if there is none."""
    file = await get_file(pool, file_id)
    if file is None:
        return None
    data = await get_file_bytes(pool, file_id)
    return StoredFileWithBytes(file=file, data=data) if data is not None else None

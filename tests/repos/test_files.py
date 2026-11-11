from __future__ import annotations

import hashlib
from datetime import datetime, timedelta

import asyncpg
import pytest

from app.db.repos.files import delete_orphan_files, get_file, get_file_bytes, insert_file, list_files
from app.db.tx import transaction
from tests.repos.seed import seed_session

PDF = b"%PDF-1.7\n" + bytes([0, 1, 2, 255, 254])


async def test_insert_file_stores_metadata_and_bytes_together_size_and_sha256_come_from_the_bytes(db) -> None:
    id = await seed_session(db.pool)
    async with transaction(db.pool) as tx:
        file = await insert_file(
            tx,
            id="f_1",
            session_id=id,
            mime="application/pdf",
            data=PDF,
            original_name="invoice.pdf",
            check_result={"pages": 1},
        )
    assert (file.id, file.session_id, file.mime, file.size, file.sha256, file.original_name, file.check_result) == (
        "f_1",
        id,
        "application/pdf",
        len(PDF),
        hashlib.sha256(PDF).hexdigest(),
        "invoice.pdf",
        {"pages": 1},
    )
    assert isinstance(file.created_at, datetime)
    async with transaction(db.pool) as tx:
        bare = await insert_file(tx, id="f_2", session_id=id, mime="image/png", data=bytes([137, 80, 78, 71]))
    assert (bare.original_name, bare.check_result, bare.size) == (None, None, 4)


async def test_insert_file_writes_nothing_if_the_transaction_fails(db) -> None:
    id = await seed_session(db.pool)
    with pytest.raises(RuntimeError, match="later step failed"):
        async with transaction(db.pool) as tx:
            await insert_file(tx, id="f_rolled_back", session_id=id, mime="image/jpeg", data=bytes([255, 216, 255]))
            raise RuntimeError("later step failed")
    assert await get_file(db.pool, "f_rolled_back") is None
    assert await get_file_bytes(db.pool, "f_rolled_back") is None
    # A type outside the allow-list is refused by the database too.
    with pytest.raises(asyncpg.PostgresError) as err:
        async with transaction(db.pool) as tx:
            await insert_file(tx, id="f_exe", session_id=id, mime="application/x-msdownload", data=PDF)
    assert err.value.sqlstate == "23514"


async def test_get_file_returns_metadata_only_get_file_bytes_returns_the_exact_bytes(db) -> None:
    id = await seed_session(db.pool)
    async with transaction(db.pool) as tx:
        await insert_file(tx, id="f_get", session_id=id, mime="application/pdf", data=PDF)
    meta = await get_file(db.pool, "f_get")
    assert meta is not None and meta.size == len(PDF)
    assert not hasattr(meta, "bytes") and not hasattr(meta, "data")
    assert await get_file_bytes(db.pool, "f_get") == PDF
    assert await get_file(db.pool, "f_none") is None
    assert await get_file_bytes(db.pool, "f_none") is None


async def test_list_files_returns_the_sessions_files_oldest_first(db) -> None:
    id = await seed_session(db.pool)
    for n in (1, 2, 3):
        async with transaction(db.pool) as tx:
            await insert_file(tx, id=f"f_list_{n}", session_id=id, mime="image/webp", data=bytes([n]))
    assert [f.id for f in await list_files(db.pool, id)] == ["f_list_1", "f_list_2", "f_list_3"]
    assert await list_files(db.pool, await seed_session(db.pool)) == []


async def test_delete_orphan_files_keeps_files_named_by_a_candidate_and_young_files(db) -> None:
    from app.db.repos.field_candidates import insert_field_candidate
    from tests.repos.seed import seed_event

    id = await seed_session(db.pool)
    seq = await seed_event(db.pool, id)
    for name in ("f_used", "f_orphan"):
        async with transaction(db.pool) as tx:
            await insert_file(tx, id=name, session_id=id, mime="image/png", data=b"x")
    await insert_field_candidate(
        db.pool,
        session_id=id,
        event_seq=seq,
        field="photos",
        source="chat",
        raw="r",
        normalized={"files": ["f_used"]},
        status="valid",
    )
    future = (await get_file(db.pool, "f_used")).created_at + timedelta(minutes=1)  # type: ignore[union-attr]
    assert await delete_orphan_files(db.pool, future - timedelta(hours=1)) == 0
    assert await delete_orphan_files(db.pool, future) == 1
    assert [f.id for f in await list_files(db.pool, id)] == ["f_used"]
    assert await get_file_bytes(db.pool, "f_orphan") is None

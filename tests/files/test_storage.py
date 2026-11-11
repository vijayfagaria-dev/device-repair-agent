from __future__ import annotations

import asyncio

from app.db.repos.files import list_files
from app.files.storage import MAX_FILES_PER_SESSION, NewUpload, read_stored_file, store_upload
from tests.repos.seed import seed_session

PNG = bytes([137, 80, 78, 71, 13, 10, 26, 10])


def upload(id: str, session_id: str, data: bytes = PNG) -> NewUpload:
    return NewUpload(id=id, session_id=session_id, mime="image/png", data=data, original_name="a.png")


async def test_store_upload_stores_metadata_and_bytes_and_read_stored_file_returns_both(db) -> None:
    id = await seed_session(db.pool)
    result = await store_upload(db.pool, upload("f_1", id), budget_bytes=1000)
    assert result.ok and result.file is not None and result.file.size == len(PNG)
    stored = await read_stored_file(db.pool, "f_1")
    assert stored is not None and stored.data == PNG and stored.file.original_name == "a.png"
    assert await read_stored_file(db.pool, "f_none") is None


async def test_store_upload_refuses_the_13th_file_of_a_session_and_uploads_over_the_budget(db) -> None:
    id = await seed_session(db.pool)
    for n in range(MAX_FILES_PER_SESSION):
        assert (await store_upload(db.pool, upload(f"f_{n}", id), budget_bytes=10_000)).ok
    result = await store_upload(db.pool, upload("f_extra", id), budget_bytes=10_000)
    assert (result.ok, result.reason, result.file) == (False, "tooManyFiles", None)
    other = await seed_session(db.pool)
    used = len(PNG) * MAX_FILES_PER_SESSION
    over = await store_upload(db.pool, upload("f_big", other), budget_bytes=used + len(PNG) - 1)
    assert (over.ok, over.reason) == (False, "budget")
    assert (await store_upload(db.pool, upload("f_fit", other), budget_bytes=used + len(PNG))).ok
    assert len(await list_files(db.pool, other)) == 1


async def test_concurrent_uploads_cannot_overshoot_the_budget(db) -> None:
    sessions = [await seed_session(db.pool) for _ in range(6)]
    results = await asyncio.gather(
        *(store_upload(db.pool, upload(f"f_c{i}", s), budget_bytes=len(PNG) * 3) for i, s in enumerate(sessions))
    )
    assert sum(r.ok for r in results) == 3
    assert {r.reason for r in results if not r.ok} == {"budget"}

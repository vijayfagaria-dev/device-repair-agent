"""Port of server/test/http/files.test.ts: uploads and signed downloads (P4-T03) over HTTP against the throwaway test
Postgres: a valid PDF round-trips with the same SHA-256 and its ref is accepted by a card; a renamed .exe -> 415; 25 MB ->
413 with no rows; over budget -> 507; a tampered signature -> 403; an expired link -> 410; plus the per-session cap and
the error shape."""

from __future__ import annotations

import asyncio
import hashlib
import re
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlsplit

import httpx
import pytest

from app.api.files import ByteQuota, attachment_header
from app.db.repos.files import list_files
from app.session.services import SessionServices
from tests.helpers.chat_flow import EXE, PDF, PNG, answer, open_card, session_at_field
from tests.helpers.http_app import build_http_app, client_for
from tests.helpers.session import TEST_SIGNER, test_services


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def link_for(file_id: str, now: datetime | None = None) -> str:
    """A signed link the test app accepts (the test signer uses https://repair.example.com as its origin)."""
    url = urlsplit(TEST_SIGNER.sign(file_id, now or datetime.now(UTC)))
    return f"{url.path}?{url.query}"


async def upload(
    client: httpx.AsyncClient,
    session_id: str,
    data: bytes,
    name: str = "invoice.pdf",
    content_type: str = "application/pdf",
) -> httpx.Response:
    return await client.post(f"/sessions/{session_id}/files", files={"file": (name, data, content_type)})


async def file_rows(db: Any) -> int:
    return int(await db.pool.fetchval("SELECT count(*)::int FROM files"))


async def blob_rows(db: Any) -> int:
    return int(await db.pool.fetchval("SELECT count(*)::int FROM file_blobs"))


class Rig:
    def __init__(self, db: Any, services: SessionServices) -> None:
        self.db = db
        self.services = services
        self.clients: list[httpx.AsyncClient] = []

    def client(self, **options: Any) -> httpx.AsyncClient:
        settings: dict[str, Any] = {"signer": TEST_SIGNER, "uploads_per_minute": 1000}
        settings.update(options)
        app = build_http_app(self.db, processor=self.services.processor, **settings)
        client = client_for(app)
        self.clients.append(client)
        return client


@pytest.fixture
async def rig(db: Any) -> AsyncIterator[Rig]:
    r = Rig(db, test_services(db, planner=True))
    yield r
    for client in r.clients:
        await client.aclose()


@pytest.fixture
async def server(rig: Rig) -> httpx.AsyncClient:
    # A generous upload limit here: this file uploads far more than a person would; the limit has its own test below.
    return rig.client(upload_budget_bytes=20 * 1024 * 1024)


async def test_stores_a_valid_pdf_lazily_creating_the_session_and_answers_with_an_opaque_file_ref_the_bytes_round_trip(
    server: httpx.AsyncClient, db: Any
) -> None:
    id = str(uuid.uuid4())
    response = await upload(server, id, PDF)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    url = response.json()["url"]
    assert re.fullmatch(r"file:f[A-Za-z0-9_-]{16}", url)
    file_id = url[len("file:") :]
    [stored] = await list_files(db.pool, id)
    assert (stored.id, stored.session_id, stored.mime, stored.size, stored.sha256, stored.original_name) == (
        file_id,
        id,
        "application/pdf",
        len(PDF),
        sha256(PDF),
        "invoice.pdf",
    )

    download = await server.get(link_for(file_id))
    assert download.status_code == 200
    assert download.headers["content-type"] == "application/pdf"
    assert (
        download.headers["content-disposition"] == "attachment; filename=\"invoice.pdf\"; filename*=UTF-8''invoice.pdf"
    )
    assert download.headers["x-content-type-options"] == "nosniff"
    assert sha256(download.content) == sha256(PDF)


async def test_the_ref_is_accepted_by_the_sessions_invoice_card(server: httpx.AsyncClient, rig: Rig) -> None:
    id = await session_at_field(rig.db, rig.services, "purchaseInvoice")
    url = (await upload(server, id, PDF)).json()["url"]
    open_ = await open_card(rig.db, id)
    assert open_ is not None
    assert await answer(rig.services, id, open_.id, "purchaseInvoice", url) == {"status": "accepted"}


async def test_refuses_a_renamed_exe_a_heic_photo_and_a_type_that_disagrees_with_the_bytes_all_415_writing_nothing(
    server: httpx.AsyncClient, db: Any
) -> None:
    id = str(uuid.uuid4())
    before = await file_rows(db)
    heic = bytes([0, 0, 0, 24]) + b"ftypheic" + bytes(16)
    for data, name, content_type in [
        (EXE, "invoice.pdf", "application/pdf"),
        (heic, "photo.heic", "image/heic"),
        (PNG, "invoice.pdf", "application/pdf"),
    ]:
        response = await upload(server, id, data, name, content_type)
        assert response.status_code == 415
        body = response.json()
        assert body["error"]["code"] == "unsupported_type"
        assert len(body["error"]["message"]) > 0
    assert await file_rows(db) == before


async def test_refuses_25_mb_with_413_and_writes_no_rows(server: httpx.AsyncClient, db: Any) -> None:
    id = str(uuid.uuid4())
    files, blobs = await file_rows(db), await blob_rows(db)
    response = await upload(server, id, PDF + bytes(25 * 1024 * 1024))
    assert response.status_code == 413
    assert response.json() == {"error": {"code": "too_large", "message": "That file is larger than 10 MB."}}
    assert await file_rows(db) == files
    assert await blob_rows(db) == blobs


async def test_an_empty_file_is_a_400_a_request_without_a_file_part_is_a_400_a_malformed_session_id_is_a_400(
    server: httpx.AsyncClient,
) -> None:
    assert (await upload(server, str(uuid.uuid4()), b"")).status_code == 400
    other = await server.post(f"/sessions/{uuid.uuid4()}/files", data={"other": "x"}, files={"unused": None})
    assert other.status_code == 400
    plain = await server.post(f"/sessions/{uuid.uuid4()}/files", content="plain")
    assert plain.status_code == 400
    wrong_name = await server.post(
        f"/sessions/{uuid.uuid4()}/files", files={"other": ("a.pdf", PDF, "application/pdf")}
    )
    assert wrong_name.status_code == 400
    bad = await upload(server, "not-a-uuid", PDF)
    assert bad.status_code == 400
    assert bad.json()["error"]["code"] == "bad_request"


async def test_caps_a_session_at_12_files_413(server: httpx.AsyncClient, db: Any) -> None:
    id = str(uuid.uuid4())
    for i in range(12):
        assert (await upload(server, id, PNG, f"p{i}.png", "image/png")).status_code == 200
    thirteenth = await upload(server, id, PNG, "p12.png", "image/png")
    assert thirteenth.status_code == 413
    assert thirteenth.json()["error"]["code"] == "too_large"
    assert len(await list_files(db.pool, id)) == 12


async def test_refuses_uploads_over_the_global_budget_with_507_writing_nothing(rig: Rig, db: Any) -> None:
    small = rig.client(upload_budget_bytes=1)
    before = await file_rows(db)
    response = await upload(small, str(uuid.uuid4()), PDF)
    assert response.status_code == 507
    assert response.json()["error"]["code"] == "storage_budget"
    assert await file_rows(db) == before


async def test_refuses_a_closed_session_410_and_more_uploads_at_once_than_the_instance_allows_429(
    server: httpx.AsyncClient, rig: Rig, db: Any
) -> None:
    id = str(uuid.uuid4())
    assert (await upload(server, id, PDF)).status_code == 200
    await db.pool.execute("UPDATE sessions SET status = 'closed' WHERE id = $1", id)
    closed = await upload(server, id, PDF)
    assert closed.status_code == 410
    assert closed.json()["error"]["code"] == "session_closed"

    busy = rig.client(max_concurrent_uploads=0)
    response = await upload(busy, str(uuid.uuid4()), PDF)
    assert response.status_code == 429
    assert response.json()["error"]["code"] == "rate_limited"


async def test_rate_limits_uploads_and_downloads_per_client_ip_separately_429_in_the_protocols_error_shape(
    rig: Rig,
) -> None:
    limited = rig.client(uploads_per_minute=1, downloads_per_minute=2)
    id = str(uuid.uuid4())
    first = await upload(limited, id, PDF)
    assert first.status_code == 200
    second = await upload(limited, id, PDF)
    assert second.status_code == 429
    assert second.json()["error"]["code"] == "rate_limited"
    # Downloads still work after uploads ran out; they have their own budget.
    file_id = first.json()["url"][len("file:") :]
    assert (await limited.get(link_for(file_id))).status_code == 200
    assert (await limited.get(link_for(file_id))).status_code == 200
    assert (await limited.get(link_for(file_id))).status_code == 429


@pytest.fixture
async def file_id(server: httpx.AsyncClient) -> str:
    return (await upload(server, str(uuid.uuid4()), PDF)).json()["url"][len("file:") :]


async def test_a_tampered_signature_expiry_or_file_id_403(server: httpx.AsyncClient, file_id: str) -> None:
    good = link_for(file_id)
    exp = re.search(r"exp=(\d+)", good)
    sig = re.search(r"sig=([A-Za-z0-9_-]+)", good)
    assert exp and sig
    # Change the first character: the last base64 character carries unused bits, so changing only it can decode to the
    # same bytes.
    changed = ("B" if sig.group(1).startswith("A") else "A") + sig.group(1)[1:]
    tampered_sig = good.replace(f"sig={sig.group(1)}", f"sig={changed}")
    tampered_exp = good.replace(f"exp={exp.group(1)}", f"exp={int(exp.group(1)) + 1}")
    other_file = good.replace(file_id, "fSomeOtherFile0000")
    for url in [tampered_sig, tampered_exp, other_file, f"/files/{file_id}"]:
        response = await server.get(url)
        assert response.status_code == 403, url
        assert response.json()["error"]["code"] == "forbidden"


async def test_an_expired_link_410(server: httpx.AsyncClient, file_id: str) -> None:
    response = await server.get(link_for(file_id, datetime.now(UTC) - timedelta(days=31)))
    assert response.status_code == 410
    assert response.json()["error"]["code"] == "expired"


async def test_a_validly_signed_link_to_a_file_that_doesnt_exist_404(server: httpx.AsyncClient) -> None:
    assert (await server.get(link_for("fNoSuchFile0000000"))).status_code == 404


def test_content_disposition_cant_be_broken_out_of_by_a_file_name() -> None:
    assert (
        attachment_header('a"b\\c\r\nd.pdf', "fX")
        == "attachment; filename=\"a_b_c__d.pdf\"; filename*=UTF-8''a%22b%5Cc%0D%0Ad.pdf"
    )
    assert attachment_header("रसीद.pdf", "fX") == (
        "attachment; filename=\"____.pdf\"; filename*=UTF-8''%E0%A4%B0%E0%A4%B8%E0%A5%80%E0%A4%A6.pdf"
    )
    assert attachment_header(None, "fAbc") == "attachment; filename=\"fAbc\"; filename*=UTF-8''fAbc"


def test_byte_quota_bytes_per_key_per_window_returned_bytes_count_again_and_the_window_resets() -> None:
    now = [0.0]
    quota = ByteQuota(100, 1000, lambda: now[0])
    assert quota.try_use("a", 60) is True
    assert quota.try_use("a", 50) is False
    assert quota.try_use("b", 100) is True
    quota.give_back("a", 60)
    assert quota.try_use("a", 100) is True
    now[0] = 1000
    assert quota.try_use("a", 100) is True


async def test_one_client_ip_cant_store_more_than_its_hourly_byte_quota_429_writing_nothing(rig: Rig, db: Any) -> None:
    limited = rig.client(upload_bytes_per_ip_per_hour=len(PDF) * 2)
    id = str(uuid.uuid4())
    assert (await upload(limited, id, PDF, "a.pdf")).status_code == 200
    assert (await upload(limited, id, PDF, "b.pdf")).status_code == 200
    before = await file_rows(db)
    third = await upload(limited, id, PDF, "c.pdf")
    assert third.status_code == 429
    assert third.json()["error"]["code"] == "rate_limited"
    assert await file_rows(db) == before


async def test_a_sender_that_trickles_its_body_is_dropped_at_the_deadline_and_frees_its_slot(rig: Rig) -> None:
    """The ASGI app is called directly with a body that starts and never finishes (what a slow sender looks like)."""
    slow = rig.client(upload_deadline_ms=300, max_concurrent_uploads=1)
    app = slow._transport.app  # type: ignore[attr-defined]
    boundary = "----slowboundary"
    head = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\n'
        "Content-Type: application/pdf\r\n\r\n%PDF-"
    ).encode()
    sent = False
    started: dict[str, Any] = {}

    async def receive() -> dict[str, Any]:
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": head, "more_body": True}
        await asyncio.sleep(3600)  # ...and never sends the rest
        return {"type": "http.disconnect"}

    async def send(message: dict[str, Any]) -> None:
        if message["type"] == "http.response.start":
            started["status"] = message["status"]

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": f"/sessions/{uuid.uuid4()}/files",
        "raw_path": b"",
        "query_string": b"",
        "headers": [
            (b"content-type", f"multipart/form-data; boundary={boundary}".encode()),
            (b"content-length", b"100000"),
            (b"host", b"localhost"),
        ],
        "client": ("127.0.0.1", 1),
        "server": ("localhost", 80),
    }
    await asyncio.wait_for(app(scope, receive, send), 5)
    assert started["status"] == 408
    # The slot is free again: a normal upload goes through.
    assert (await upload(slow, str(uuid.uuid4()), PDF)).status_code == 200

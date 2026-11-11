"""Port of server/test/limits/limits.test.ts (the HTTP limits; the call-capacity, max-duration and new-session
WebSocket limits need the socket transport and live with its tests).

P10-T03 acceptance: each limit, when exceeded, gives its documented response AND a log line. One test per limit, with a
capturing logger: the read-API rate limit (429), the upload rate limit (429), the upload budget (507), the override
route's rate limit (429)."""

from __future__ import annotations

import io
import json
import uuid
from typing import Any

import httpx

from app.config import Secret
from app.limits.quota_guard import QuotaGuard, QuotaSettings
from app.logging import create_logger
from tests.helpers.chat_flow import PDF
from tests.helpers.http_app import build_http_app, client_for
from tests.helpers.session import TEST_SIGNER


class Logged:
    def __init__(self) -> None:
        self.stream = io.StringIO()
        self.log = create_logger("info", self.stream)

    @property
    def lines(self) -> list[dict[str, Any]]:
        return [json.loads(line) for line in self.stream.getvalue().splitlines() if line]

    def has(self, message: str) -> bool:
        return any(line["msg"] == message for line in self.lines)


async def upload(client: httpx.AsyncClient, id: str) -> httpx.Response:
    return await client.post(f"/sessions/{id}/files", files={"file": ("a.pdf", PDF, "application/pdf")})


async def test_read_api_429_rate_limited(db: Any) -> None:
    logged = Logged()
    async with client_for(build_http_app(db, log=logged.log, api_rate_limit_per_minute=2)) as client:
        id = uuid.uuid4()
        codes = [(await client.get(f"/api/sessions/{id}")).status_code for _ in range(4)]
        assert codes[2:] == [429, 429]
        assert logged.has("rate limit exceeded")


async def test_uploads_per_minute_429_rate_limited(db: Any) -> None:
    logged = Logged()
    app = build_http_app(db, log=logged.log, signer=TEST_SIGNER, uploads_per_minute=1)
    async with client_for(app) as client:
        id = str(uuid.uuid4())
        assert (await upload(client, id)).status_code == 200
        second = await upload(client, id)
        assert second.status_code == 429
        assert second.json()["error"]["code"] == "rate_limited"
        assert logged.has("rate limit exceeded")


async def test_the_upload_budget_507_storage_budget(db: Any) -> None:
    logged = Logged()
    app = build_http_app(db, log=logged.log, signer=TEST_SIGNER, upload_budget_bytes=1)
    async with client_for(app) as client:
        response = await upload(client, str(uuid.uuid4()))
        assert response.status_code == 507
        assert response.json()["error"]["code"] == "storage_budget"
        assert any(line["msg"].startswith("upload refused: the global upload budget") for line in logged.lines)


async def test_the_quota_override_route_429_after_five_attempts_a_minute(db: Any) -> None:
    logged = Logged()
    guard = QuotaGuard(
        db.pool,
        QuotaSettings(llm_requests_per_day=5, audio_minutes_per_day=5, override_token=Secret("t" * 32)),
        logged.log,
    )
    async with client_for(build_http_app(db, log=logged.log, quota=guard)) as client:
        codes = [(await client.post("/api/quota/override")).status_code for _ in range(7)]
        assert codes.count(401) == 5
        assert codes[5:] == [429, 429]
        assert logged.has("rate limit exceeded")
        assert logged.has("quota override refused")

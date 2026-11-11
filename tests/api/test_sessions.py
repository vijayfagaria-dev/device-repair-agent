"""Port of server/test/http/sessions.test.ts: POST /api/sessions, the token-gated test API (P1-T03 step 4)."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest

from app.api.sessions import has_bearer_token
from app.config import Secret
from app.db.repos.events import list_events
from app.db.repos.sessions import get_session
from app.protocol.session import parse_session_id
from tests.helpers.fake import FAKE
from tests.helpers.http_app import build_http_app, client_for
from tests.helpers.session import test_services

TOKEN = Secret(FAKE["TEST_API_TOKEN"])


@pytest.fixture
async def enabled(db: Any) -> AsyncIterator[httpx.AsyncClient]:
    app = build_http_app(db, test_api_token=TOKEN, processor=test_services(db).processor)
    async with client_for(app) as c:
        yield c


@pytest.fixture
async def disabled(db: Any) -> AsyncIterator[httpx.AsyncClient]:
    async with client_for(build_http_app(db)) as c:
        yield c


async def post(client: httpx.AsyncClient, authorization: str | None = None) -> httpx.Response:
    return await client.post("/api/sessions", headers={"authorization": authorization} if authorization else {})


async def count_sessions(db: Any) -> int:
    return int(await db.pool.fetchval("SELECT count(*)::int FROM sessions"))


async def test_doesnt_exist_unless_the_test_api_is_enabled(disabled: httpx.AsyncClient) -> None:
    res = await post(disabled, f"Bearer {FAKE['TEST_API_TOKEN']}")
    assert res.status_code == 404
    assert res.json() == {"error": "not_found"}


async def test_rejects_a_missing_or_wrong_token_without_creating_anything(enabled: httpx.AsyncClient, db: Any) -> None:
    before = await count_sessions(db)
    headers = [
        None,
        "Bearer",
        "Bearer ",
        f"Bearer {FAKE['TEST_API_TOKEN']}x",
        FAKE["TEST_API_TOKEN"],
        f"Basic {FAKE['TEST_API_TOKEN']}",
    ]
    for header in headers:
        res = await post(enabled, header)
        assert res.status_code == 401, str(header)
        assert res.json() == {"error": "unauthorized"}
    assert await count_sessions(db) == before


async def test_creates_a_session_with_a_server_generated_uuidv4_and_returns_it(
    enabled: httpx.AsyncClient, db: Any
) -> None:
    res = await post(enabled, f"Bearer {FAKE['TEST_API_TOKEN']}")
    assert res.status_code == 201
    assert res.headers["cache-control"] == "no-store"
    session_id = res.json()["sessionId"]
    assert parse_session_id(session_id) == session_id
    assert await get_session(db.pool, session_id) is not None
    events = await list_events(db.pool, session_id)
    assert [(e.type, e.payload) for e in events] == [("session.created", {"via": "testApi"})]


async def test_isnt_subject_to_the_browsers_per_ip_creation_limit_it_is_token_gated(enabled: httpx.AsyncClient) -> None:
    ids = {(await post(enabled, f"Bearer {FAKE['TEST_API_TOKEN']}")).json()["sessionId"] for _ in range(5)}
    assert len(ids) == 5


def test_has_bearer_token_accepts_only_the_exact_token() -> None:
    assert has_bearer_token(f"Bearer {FAKE['TEST_API_TOKEN']}", TOKEN) is True
    assert has_bearer_token(f"bearer {FAKE['TEST_API_TOKEN']}", TOKEN) is False
    assert has_bearer_token(f"Bearer {FAKE['TEST_API_TOKEN'][:-1]}", TOKEN) is False
    assert has_bearer_token(None, TOKEN) is False

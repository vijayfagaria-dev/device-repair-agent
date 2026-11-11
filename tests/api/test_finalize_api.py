"""Port of server/test/http/finalizeApi.test.ts: POST /api/sessions/{id}/finalize (P7-T01), the token-gated test trigger.
Off unless ALLOW_TEST_API; a trigger like any other (an active session only, the usual dedup)."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest

from app.config import Secret
from app.db.repos.records import list_records
from tests.helpers.fake import FAKE
from tests.helpers.http_app import build_http_app, client_for
from tests.helpers.seed import seed_session
from tests.helpers.session import test_services


@pytest.fixture
async def clients(db: Any) -> AsyncIterator[tuple[httpx.AsyncClient, httpx.AsyncClient]]:
    services = test_services(db)
    on = build_http_app(db, processor=services.processor, test_api_token=Secret(FAKE["TEST_API_TOKEN"]))
    off = build_http_app(db)
    async with client_for(on) as a, client_for(off) as b:
        yield a, b


async def finalize(client: httpx.AsyncClient, id: str, token: str | None) -> httpx.Response:
    return await client.post(
        f"/api/sessions/{id}/finalize", headers={"authorization": f"Bearer {token}"} if token else {}
    )


async def test_needs_the_test_token(clients: Any, db: Any) -> None:
    on, _ = clients
    id = await seed_session(db.pool)
    for token in [None, "wrong", FAKE["HOOK_SECRET"], FAKE["QUOTA_OVERRIDE_TOKEN"]]:
        assert (await finalize(on, id, token)).status_code == 401, str(token)
    assert await list_records(db.pool, id) == []


async def test_is_not_registered_when_the_test_api_is_off_even_with_a_token(clients: Any, db: Any) -> None:
    _, off = clients
    id = await seed_session(db.pool)
    assert (await finalize(off, id, FAKE["TEST_API_TOKEN"])).status_code == 404
    assert await list_records(db.pool, id) == []


async def test_finalizes_an_active_session_once_a_second_call_is_a_no_op(clients: Any, db: Any) -> None:
    on, _ = clients
    id = await seed_session(db.pool)
    first = await finalize(on, id, FAKE["TEST_API_TOKEN"])
    assert first.status_code == 200
    assert first.json() == {"finalized": True, "revision": 1, "outcome": "partial"}
    assert [r.revision for r in await list_records(db.pool, id)] == [1]
    assert (await finalize(on, id, FAKE["TEST_API_TOKEN"])).json() == {
        "finalized": False,
        "reason": "session is finalized",
    }
    assert len(await list_records(db.pool, id)) == 1


async def test_404_for_an_unknown_session_400_for_a_malformed_id(clients: Any) -> None:
    on, _ = clients
    assert (await finalize(on, str(uuid.uuid4()), FAKE["TEST_API_TOKEN"])).status_code == 404
    assert (await finalize(on, "not-a-uuid", FAKE["TEST_API_TOKEN"])).status_code == 400

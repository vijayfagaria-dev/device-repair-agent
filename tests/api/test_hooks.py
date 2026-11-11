"""Port of server/test/http/hooks.test.ts: the stub record receiver (P7-T04): idempotent storage, the secret, the key
checks, the token-gated listing."""

from __future__ import annotations

import dataclasses
import json
import uuid
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest

from app.config import Secret
from app.db.repos.received_records import list_received_records
from app.domain.record import build_record
from tests.domain.scenarios import SCENARIOS
from tests.helpers.fake import FAKE
from tests.helpers.http_app import build_http_app, client_for
from tests.helpers.record_oracle import expect_sanitized_record
from tests.helpers.session import test_services

HOOK_SECRET = Secret(FAKE["HOOK_SECRET"])
TEST_API_TOKEN = Secret(FAKE["TEST_API_TOKEN"])


@pytest.fixture
async def app_client(db: Any) -> AsyncIterator[httpx.AsyncClient]:
    app = build_http_app(
        db, hook_secret=HOOK_SECRET, test_api_token=TEST_API_TOKEN, processor=test_services(db).processor
    )
    async with client_for(app) as c:
        yield c


@pytest.fixture
async def without_test_api(db: Any) -> AsyncIterator[httpx.AsyncClient]:
    async with client_for(build_http_app(db, hook_secret=HOOK_SECRET)) as c:
        yield c


def delivery(revision: int = 1) -> tuple[str, dict[str, Any], str]:
    session_id = str(uuid.uuid4())
    built = build_record(dataclasses.replace(SCENARIOS["partial"](), session_id=session_id, revision=revision))
    return session_id, built.record, f"{session_id}:{revision}"  # type: ignore[return-value]


async def post(
    client: httpx.AsyncClient, key: str | None, body: Any, secret: str | None = FAKE["HOOK_SECRET"]
) -> httpx.Response:
    headers = {"content-type": "application/json"}
    if key:
        headers["idempotency-key"] = key
    if secret:
        headers["x-hook-secret"] = secret
    return await client.post("/hooks/records", headers=headers, content=json.dumps(body))


async def stored(db: Any, key: str) -> Any:
    return next((r for r in await list_received_records(db.pool) if r.idempotency_key == key), None)


async def test_3_identical_deliveries_give_one_row_with_times_received_3_all_answered_200_the_first_payload_is_kept(
    app_client: httpx.AsyncClient, db: Any
) -> None:
    _, record, key = delivery()
    statuses = [(await post(app_client, key, record)).status_code for _ in range(3)]
    assert statuses == [200, 200, 200]
    row = await stored(db, key)
    assert (row.idempotency_key, row.times_received, row.payload) == (key, 3, record)
    assert len([r for r in await list_received_records(db.pool) if r.idempotency_key == key]) == 1
    assert (await post(app_client, key, record)).json() == {"stored": True, "timesReceived": 4}


async def test_a_wrong_or_missing_secret_is_401_and_stores_nothing_whatever_the_body(
    app_client: httpx.AsyncClient, db: Any
) -> None:
    _, record, key = delivery()
    for secret in [None, "", "wrong", FAKE["HOOK_SECRET"] + "x", FAKE["HOOK_SECRET"][1:], FAKE["TEST_API_TOKEN"]]:
        res = await post(app_client, key, record, secret)
        assert res.status_code == 401, str(secret)
        assert res.json() == {"error": "unauthorized"}
    res = await app_client.post(
        "/hooks/records",
        headers={"content-type": "application/json", "idempotency-key": key, "x-hook-secret": "wrong"},
        content="{not json",
    )
    assert res.status_code == 401  # refused before the body is read
    assert await stored(db, key) is None


async def test_rejects_a_missing_or_malformed_key_a_key_that_doesnt_match_the_record_and_a_record_that_breaks_the_schema(
    app_client: httpx.AsyncClient, db: Any
) -> None:
    session_id, record, key = delivery(2)
    assert (await post(app_client, None, record)).status_code == 400
    for bad in ["nope", session_id, f"{session_id}:0", f"{session_id}:x", "not-a-uuid:2"]:
        assert (await post(app_client, bad, record)).status_code == 400, bad
    assert (await post(app_client, f"{session_id}:3", record)).json()["error"] == "key_mismatch"
    assert (await post(app_client, f"{uuid.uuid4()}:2", record)).json()["error"] == "key_mismatch"
    broken = await post(app_client, key, {**record, "outcome": "banana", "extra": "/data/x"})
    assert broken.status_code == 400
    assert broken.json()["error"] == "invalid_record"
    assert "banana" not in broken.text
    assert "/data/x" not in broken.text  # paths and keywords only
    assert await stored(db, key) is None


async def test_a_different_revision_of_the_same_session_is_a_different_key_two_rows(
    app_client: httpx.AsyncClient, db: Any
) -> None:
    session_id = str(uuid.uuid4())
    for revision in (1, 2):
        built = build_record(dataclasses.replace(SCENARIOS["partial"](), session_id=session_id, revision=revision))
        assert (await post(app_client, f"{session_id}:{revision}", built.record)).status_code == 200
    rows = [r for r in await list_received_records(db.pool) if r.idempotency_key.startswith(session_id)]
    assert [r.times_received for r in rows] == [1, 1]


async def test_caps_the_body_it_will_read(app_client: httpx.AsyncClient) -> None:
    _, _, key = delivery()
    assert (await post(app_client, key, {"filler": "x" * 300_000})).status_code == 413


async def test_lists_what_was_received_only_with_the_test_token(app_client: httpx.AsyncClient) -> None:
    _, record, key = delivery()
    await post(app_client, key, record)
    assert (await app_client.get("/hooks/records")).status_code == 401
    assert (await app_client.get("/hooks/records", headers={"authorization": "Bearer wrong"})).status_code == 401
    # the hook secret is not the test token
    assert (
        await app_client.get("/hooks/records", headers={"authorization": f"Bearer {FAKE['HOOK_SECRET']}"})
    ).status_code == 401
    res = await app_client.get("/hooks/records", headers={"authorization": f"Bearer {FAKE['TEST_API_TOKEN']}"})
    assert res.status_code == 200
    assert res.headers["cache-control"] == "no-store"
    mine = next(r for r in res.json()["records"] if r["idempotencyKey"] == key)
    assert mine["timesReceived"] == 1
    assert mine["record"] == record
    expect_sanitized_record(mine["record"], [FAKE["HOOK_SECRET"], FAKE["TEST_API_TOKEN"]])


async def test_does_not_exist_when_the_test_api_is_off_and_post_still_works(
    without_test_api: httpx.AsyncClient,
) -> None:
    res = await without_test_api.get("/hooks/records", headers={"authorization": f"Bearer {FAKE['TEST_API_TOKEN']}"})
    assert res.status_code == 404
    _, record, key = delivery()
    assert (await post(without_test_api, key, record)).status_code == 200

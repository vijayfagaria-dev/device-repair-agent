"""Port of server/test/http/sessionsRead.test.ts: GET /api/sessions/{id}, /timeline, /records (P3-T02): DTOs, 404/400, no
secrets, internal paths or provider ids, and the per-IP rate limit."""

from __future__ import annotations

import dataclasses
import uuid
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest

from app.db.repos.events import append_event
from app.db.repos.records import insert_record
from app.db.repos.sessions import lock_session
from app.db.tx import transaction
from app.domain.record import build_record
from app.metrics.usage import record_usage
from tests.domain.scenarios import SCENARIOS
from tests.helpers.fake import FAKE_SECRET_VALUES
from tests.helpers.http_app import build_http_app, client_for
from tests.helpers.record_oracle import expect_no_leaks, expect_sanitized_record
from tests.helpers.seed import HASH, seed_session
from tests.helpers.session import seed_call, test_services


@pytest.fixture
async def rig(db: Any) -> AsyncIterator[tuple[Any, httpx.AsyncClient, Any]]:
    services = test_services(db)
    app = build_http_app(db, api_rate_limit_per_minute=1000)
    async with client_for(app) as client:
        yield db, client, services


async def rich_session(db: Any, services: Any) -> str:
    """A session with a bit of everything: chat, a call line, cards, candidates (incl. a conflict and a file), usage."""
    id = await seed_session(db.pool)

    async def run(command: dict[str, Any]) -> None:
        await services.processor.dispatch(id, command)

    call_id = f"c{id[:8]}"
    await seed_call(db, id, call_id)
    await run({"type": "Test.Say", "message_id": f"msg{call_id}", "text": "Hi, I'm the claims assistant."})
    await run(
        {"type": "Test.Transcript", "line_id": f"tu_{call_id}_1", "call_id": call_id, "text": "It's an iPhone 14 Pro"}
    )
    await run(
        {
            "type": "Test.Candidate",
            "field": "deviceType",
            "source": "call",
            "raw": "phone",
            "normalized": "smartphone",
            "evidence": "user: it's my phone",
        }
    )
    await run(
        {
            "type": "Test.Candidate",
            "field": "email",
            "source": "call",
            "raw": "asha@example.com",
            "normalized": "asha@example.com",
            "status": "unverified",
        }
    )
    await run(
        {
            "type": "Test.Candidate",
            "field": "email",
            "source": "chat",
            "raw": "other@example.com",
            "normalized": "other@example.com",
        }
    )
    await run(
        {
            "type": "Test.Candidate",
            "field": "purchaseInvoice",
            "source": "chat",
            "raw": "file:fInv0000001",
            "normalized": {
                "fileId": "fInv0000001",
                "mime": "application/pdf",
                "size": 1200,
                "sha256": "c" * 64,
                "path": "/var/data/x.pdf",
            },
        }
    )
    await run({"type": "Test.OpenCard", "request_id": "req_serialNumber_1", "field": "serialNumber"})
    await record_usage(db.pool, session_id=id, provider="deepgram", kind="nova-3:audio", units=60)
    # An event payload that (wrongly) carries secrets and provider ids must not leak through the timeline.
    async with transaction(db.pool) as tx:
        await lock_session(tx, id)
        await append_event(
            tx,
            session_id=id,
            type="agent.turn",
            channel="call",
            payload={
                "ttftMs": 640,
                "promptTokens": 812,  # a count, not a credential: kept
                "providerRequestId": "req-groq-123",
                "providerCallId": "dg-call-456",
                "apiKey": "sk-not-real",
                "access_token": "at-not-real",
                "nested": {
                    "authorization": "Bearer x",
                    "filePath": "/tmp/a",
                    "file_path": "/tmp/b",
                    "storagePath": "/tmp/c",
                    "storageKey": "bucket/key-1",
                    "keep": 1,
                },
            },
        )
    return id


async def test_returns_the_state_with_every_fields_effective_value_from_the_resolver(rig: Any) -> None:
    db, client, services = rig
    id = await rich_session(db, services)
    res = await client.get(f"/api/sessions/{id}")
    assert res.status_code == 200
    assert res.headers["cache-control"] == "no-store"
    body = res.json()
    assert body["sessionId"] == id
    assert (body["status"], body["outcome"], body["revision"], body["callActive"]) == ("active", None, None, False)
    assert body["openRequest"] == {"id": "req_serialNumber_1", "field": "serialNumber"}
    device_type = body["fields"]["deviceType"]
    assert (device_type["value"], device_type["source"], device_type["status"]) == ("smartphone", "call", "valid")
    # typed beats spoken (D15)
    assert body["fields"]["email"]["value"] == "other@example.com"
    assert (body["fields"]["email"]["source"], body["fields"]["email"]["status"]) == ("chat", "valid")
    assert body["fields"]["serialNumber"] == {"value": None, "source": None, "collectedAt": None, "status": "missing"}
    # no url, no path
    assert body["fields"]["purchaseInvoice"]["value"] == {
        "fileId": "fInv0000001",
        "mime": "application/pdf",
        "size": 1200,
        "sha256": "c" * 64,
    }
    assert "serialNumber" in body["missingRequired"]
    assert "email" not in body["missingRequired"]
    assert len(body["conflicts"]) == 1
    conflict = body["conflicts"][0]
    assert conflict["field"] == "email"
    assert conflict["resolution"] == "chatValue"
    assert (conflict["callValue"], conflict["chatValue"]) == ("asha@example.com", "other@example.com")
    assert len(body["fields"]) == 11


async def test_returns_404_for_an_unknown_id_and_400_for_a_malformed_one_creating_nothing(rig: Any) -> None:
    db, client, _ = rig
    before = await db.pool.fetchval("SELECT count(*)::int FROM sessions")
    for path in ["", "/timeline", "/records"]:
        unknown = await client.get(f"/api/sessions/{uuid.uuid4()}{path}")
        assert unknown.status_code == 404, path
        assert unknown.json() == {"error": "not_found", "message": "No such session."}
        assert (await client.get(f"/api/sessions/not-a-uuid{path}")).status_code == 400, path
    assert await db.pool.fetchval("SELECT count(*)::int FROM sessions") == before


async def test_is_a_read_it_never_counts_as_activity_or_changes_the_session(rig: Any) -> None:
    db, client, services = rig
    id = await rich_session(db, services)
    query = "SELECT version, last_activity_at FROM sessions WHERE id = $1"
    before = dict(await db.pool.fetchrow(query, id))
    await client.get(f"/api/sessions/{id}")
    await client.get(f"/api/sessions/{id}/timeline")
    assert dict(await db.pool.fetchrow(query, id)) == before


async def test_timeline_returns_events_transcript_and_cost_without_secrets_internal_paths_provider_ids_or_llm_evidence(
    rig: Any,
) -> None:
    db, client, services = rig
    id = await rich_session(db, services)
    res = await client.get(f"/api/sessions/{id}/timeline")
    assert res.status_code == 200
    body = res.json()
    assert [e["type"] for e in body["events"]] == [
        "chat.message",
        "transcript.final",
        "field.candidate",
        "field.candidate",
        "field.candidate",
        "field.candidate",
        "input.requested",
        "agent.turn",
    ]
    assert [e["seq"] for e in body["events"]] == [1, 2, 3, 4, 5, 6, 7, 8]
    call_id = f"c{id[:8]}"
    assert len(body["transcript"]) == 1
    line = body["transcript"][0]
    assert (line["id"], line["callId"], line["role"], line["text"]) == (
        f"tu_{call_id}_1",
        call_id,
        "user",
        "It's an iPhone 14 Pro",
    )
    assert body["cost"]["costUsd"] == pytest.approx(0.0077, abs=1e-8)
    assert len(body["usage"]) == 1
    assert (
        body["usage"][0]["provider"],
        body["usage"][0]["kind"],
        body["usage"][0]["units"],
        body["usage"][0]["unit"],
    ) == (
        "deepgram",
        "nova-3:audio",
        60,
        "second",
    )
    assert body["events"][-1]["payload"] == {"ttftMs": 640, "promptTokens": 812, "nested": {"keep": 1}}
    for leak in [
        "req-groq-123",
        "dg-call-456",
        "sk-not-real",
        "at-not-real",
        "Bearer x",
        "/tmp/a",
        "/tmp/b",
        "/tmp/c",
        "bucket/key-1",
        "/var/data",
        "user: it's my phone",
    ]:
        assert leak not in res.text, leak


async def test_records_lists_the_immutable_revisions_oldest_first(rig: Any) -> None:
    db, client, _ = rig
    id = await seed_session(db.pool)
    assert (await client.get(f"/api/sessions/{id}/records")).json() == {"sessionId": id, "records": []}
    await insert_record(
        db.pool, session_id=id, revision=1, outcome="partial", payload={"revision": 1}, content_hash=HASH
    )
    await insert_record(
        db.pool, session_id=id, revision=2, outcome="completed", payload={"revision": 2}, content_hash="1" * 64
    )
    body = (await client.get(f"/api/sessions/{id}/records")).json()
    assert [[r["revision"], r["outcome"]] for r in body["records"]] == [[1, "partial"], [2, "completed"]]
    assert body["records"][1]["record"] == {"revision": 2}


async def test_rate_limit_allows_the_configured_requests_per_ip_per_minute_then_429_with_a_json_error(db: Any) -> None:
    limited = build_http_app(db, api_rate_limit_per_minute=3, trust_proxy_hops=1)
    async with client_for(limited) as client:
        id = await seed_session(db.pool)
        statuses = [(await client.get(f"/api/sessions/{id}")).status_code for _ in range(4)]
        assert statuses == [200, 200, 200, 429]
        refused = await client.get(f"/api/sessions/{id}/records")
        assert refused.status_code == 429
        body = refused.json()
        assert body["error"] == "rate_limited"
        assert body["message"].startswith("Too many requests")
        assert refused.headers["retry-after"]
        # Another client IP has its own budget; health checks are never limited.
        other = await client.get(f"/api/sessions/{id}", headers={"x-forwarded-for": "10.0.0.9"})
        assert other.status_code == 200
        for _ in range(5):
            assert (await client.get("/healthz")).status_code == 200


async def test_sanitization_oracle_state_and_timeline_no_leak_of_any_class(rig: Any) -> None:
    db, client, services = rig
    id = await rich_session(db, services)
    expect_no_leaks((await client.get(f"/api/sessions/{id}")).json(), FAKE_SECRET_VALUES)
    timeline = (await client.get(f"/api/sessions/{id}/timeline")).json()
    expect_no_leaks(timeline, FAKE_SECRET_VALUES)
    # The upload ref the page sent ("file:<id>") is shown as the bare file id.
    invoice = next(e for e in timeline["events"] if e["payload"].get("candidate", {}).get("field") == "purchaseInvoice")
    assert invoice["payload"]["candidate"]["raw"] == "fInv0000001"


async def test_sanitization_oracle_records_every_revision_passes_the_record_oracle(rig: Any) -> None:
    db, client, _ = rig
    id = await seed_session(db.pool)
    built = [
        build_record(dataclasses.replace(SCENARIOS[name](), session_id=id, revision=i + 1))
        for i, name in enumerate(["partial", "completed"])
    ]
    for b in built:
        await insert_record(
            db.pool,
            session_id=id,
            revision=b.record["revision"],
            outcome=b.record["outcome"],
            payload=b.record,  # type: ignore[arg-type]
            content_hash=b.content_hash,
        )
    body = (await client.get(f"/api/sessions/{id}/records")).json()
    assert len(body["records"]) == 2
    for entry in body["records"]:
        expect_sanitized_record(entry["record"], FAKE_SECRET_VALUES)
    expect_no_leaks(body, FAKE_SECRET_VALUES, True)

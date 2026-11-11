"""Port of server/test/delivery/endToEnd.test.ts: idempotent delivery end to end (P7-T02..T04): a real commit nudges the
worker, which POSTs to this server's own stub receiver (in-process, over ASGI); the receiver ends up with exactly one
row per (session, revision), also when a delivery is repeated, and a rejected delivery is visible in the session's
timeline."""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest

from app.config import Secret
from app.db.repos.outbox import list_outbox, save_outbox
from app.db.repos.received_records import list_received_records
from app.db.repos.timers import Timer, upsert_timer
from app.delivery.worker import Backoff, OutboxWorker
from app.logging import create_logger
from app.session.handlers.timers import TimerFired
from tests.helpers.chat_flow import (
    ANSWERS,
    answer,
    answer_open,
    open_card,
    session_at_field,
    store_test_file,
)
from tests.helpers.fake import FAKE
from tests.helpers.http_app import build_http_app, client_for
from tests.helpers.session import test_services

HOOK_SECRET = Secret(FAKE["HOOK_SECRET"])
TEST_API_TOKEN = Secret(FAKE["TEST_API_TOKEN"])
FAST = Backoff(15, 60)


class Rig:
    def __init__(self, db: Any, client: httpx.AsyncClient, services: Any) -> None:
        self.db = db
        self.client = client
        self.services = services
        self.worker: OutboxWorker

    def make_worker(self, hook_secret: Secret = HOOK_SECRET) -> OutboxWorker:
        return OutboxWorker(
            pool=self.db.pool,
            log=create_logger("silent"),
            url=Secret("http://repair.example.com/hooks/records"),
            hook_secret=hook_secret,
            client=self.client,
            backoff=FAST,
        )


@pytest.fixture
async def rig(db: Any) -> AsyncIterator[Rig]:
    holder: list[OutboxWorker] = []
    services = test_services(db, planner=True, on_outbox_queued=lambda: holder and holder[0].notify())
    app = build_http_app(db, hook_secret=HOOK_SECRET, test_api_token=TEST_API_TOKEN, processor=services.processor)
    async with client_for(app) as client:
        r = Rig(db, client, services)
        r.worker = r.make_worker()
        holder.append(r.worker)
        await r.worker.start()
        yield r
        await r.worker.stop()


async def until(check: Callable[[], Awaitable[bool]], what: str, limit: float = 4.0) -> None:
    deadline = time.monotonic() + limit
    while not await check():
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out waiting for {what}")
        await asyncio.sleep(0.01)


async def received(db: Any, id: str) -> list[Any]:
    return [r for r in await list_received_records(db.pool) if r.idempotency_key.startswith(id)]


async def idle(rig: Rig, id: str) -> None:
    await upsert_timer(rig.db.pool, Timer(session_id=id, kind="idle", due_at=datetime.now(UTC) - timedelta(seconds=1)))
    await rig.services.processor.dispatch(id, TimerFired(kind="idle", due_at=datetime.now(UTC)))


async def test_revision_1_partial_and_then_revision_2_completed_each_reach_the_receiver_once_in_order(rig: Rig) -> None:
    db, services = rig.db, rig.services
    id = await session_at_field(db, services, "email")
    await idle(rig, id)

    async def one() -> bool:
        return len(await received(db, id)) == 1

    await until(one, "revision 1 at the receiver")  # nudged, no polling
    first = (await received(db, id))[0]
    assert (first.idempotency_key, first.times_received) == (f"{id}:1", 1)
    assert (first.payload["outcome"], first.payload["revision"]) == ("partial", 1)

    await answer_open(db, services, id, "email", ANSWERS["email"])
    for _ in range(4):
        open_ = await open_card(db, id)
        if open_ is None or open_.field == "submitConfirmation":
            break
        value = (
            f"file:{(await store_test_file(db, id)).id}" if open_.field == "purchaseInvoice" else ANSWERS[open_.field]
        )
        await answer(services, id, open_.id, open_.field, value)
    await answer_open(db, services, id, "submitConfirmation", True)

    async def two() -> bool:
        return len(await received(db, id)) == 2

    await until(two, "revision 2 at the receiver")
    rows = await received(db, id)
    assert [[r.idempotency_key, r.times_received] for r in rows] == [[f"{id}:1", 1], [f"{id}:2", 1]]
    assert rows[1].payload["outcome"] == "completed"
    assert rows[1].payload["previousRevision"]["revision"] == 1
    assert rows[1].payload["previousRevision"]["outcome"] == "partial"
    assert rows[0].first_received_at <= rows[1].first_received_at

    async def delivered() -> bool:
        return all(o.status == "delivered" for o in await list_outbox(db.pool, id))

    await until(delivered, "both marked delivered")


async def test_a_delivery_repeated_after_a_crash_received_but_not_marked_is_stored_once(rig: Rig) -> None:
    db, services = rig.db, rig.services
    id = await session_at_field(db, services, "email")
    await idle(rig, id)

    async def is_delivered() -> bool:
        rows = await list_outbox(db.pool, id)
        return bool(rows) and rows[0].status == "delivered"

    await until(is_delivered, "delivered")
    [row] = await list_outbox(db.pool, id)
    # As if the process died between the receiver's 200 and the bookkeeping.
    await save_outbox(
        db.pool,
        id=row.id,
        status="pending",
        attempts=1,
        next_attempt_at=datetime.now(UTC),
        last_error=None,
        delivered_at=None,
    )
    rig.worker.notify()

    async def twice() -> bool:
        rows = await received(db, id)
        return bool(rows) and rows[0].times_received == 2

    await until(twice, "the repeat")
    assert len(await received(db, id)) == 1
    await until(is_delivered, "delivered again")


async def test_a_delivery_the_receiver_rejects_is_dead_and_the_timeline_shows_it_with_its_error(rig: Rig) -> None:
    db, services = rig.db, rig.services
    id = await session_at_field(db, services, "email")
    wrong = rig.make_worker(Secret("not-the-hook-secret-0000000000000000"))
    await rig.worker.stop()  # only the misconfigured worker handles this row
    await idle(rig, id)
    await wrong.start()

    async def is_dead() -> bool:
        rows = await list_outbox(db.pool, id)
        return bool(rows) and rows[0].status == "dead"

    await until(is_dead, "dead")
    await wrong.stop()
    assert await received(db, id) == []
    timeline = (await rig.client.get(f"/api/sessions/{id}/timeline")).json()
    assert len(timeline["deliveries"]) == 1
    delivery = timeline["deliveries"][0]
    assert (delivery["revision"], delivery["target"], delivery["status"], delivery["attempts"]) == (
        1,
        "webhook",
        "dead",
        1,
    )
    assert (delivery["lastError"], delivery["nextAttemptAt"], delivery["deliveredAt"]) == ("HTTP 401", None, None)
    await rig.worker.start()

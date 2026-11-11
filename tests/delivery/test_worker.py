"""Port of server/test/delivery/worker.test.ts: the outbox worker against a local HTTP receiver whose behaviour each
test scripts: retries with backoff, per-session revision order, dead-lettering, leases, two workers, restart pickup,
and the headers it sends."""

from __future__ import annotations

import asyncio
import dataclasses
import json
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from app.config import Secret
from app.db.pool import Database
from app.db.repos.outbox import insert_outbox, list_outbox, save_outbox
from app.db.repos.records import insert_record
from app.delivery.worker import Backoff, OutboxWorker
from app.domain.record import build_record
from app.logging import create_logger
from tests.delivery.receiver import Received, Receiver, Verdict, start_receiver
from tests.domain.scenarios import SCENARIOS
from tests.repos.seed import seed_session

HOOK_SECRET = Secret("hook-secret-for-the-worker-test-000000")
FAST = {"backoff": Backoff(15, 60), "random": lambda: 1.0}
log = create_logger("silent")


class Rig:
    def __init__(self, db: Database, schema: Any) -> None:
        self.db = db
        self.schema = schema
        self.workers: list[OutboxWorker] = []
        self.receivers: list[Receiver] = []
        self.extra_dbs: list[Database] = []

    def worker(self, url: Secret, **options: Any) -> OutboxWorker:
        settings: dict[str, Any] = {"pool": self.db.pool, "log": log, "url": url, "hook_secret": HOOK_SECRET, **FAST}
        settings.update(options)
        w = OutboxWorker(**settings)
        self.workers.append(w)
        return w

    async def serve(self, respond: Callable[[Received, int], Verdict]) -> Receiver:
        r = await start_receiver(respond)
        self.receivers.append(r)
        return r

    async def session_with_deliveries(self, revisions: int) -> str:
        id = await seed_session(self.db.pool)
        names = ["partial", "completed", "needsReview", "optedOut"]
        for revision in range(1, revisions + 1):
            built = build_record(
                dataclasses.replace(
                    SCENARIOS[names[revision - 1] if revision <= 4 else "partial"](), session_id=id, revision=revision
                )
            )
            await insert_record(
                self.db.pool,
                session_id=id,
                revision=revision,
                outcome=built.record["outcome"],
                payload=built.record,  # type: ignore[arg-type]
                content_hash=str(revision) * 64,
            )
            await insert_outbox(self.db.pool, session_id=id, revision=revision, target="webhook")
        return id

    async def states(self, id: str) -> list[list[Any]]:
        return [[o.revision, o.status, o.attempts] for o in await list_outbox(self.db.pool, id)]


@pytest.fixture
async def rig(db: Database, schema: Any) -> AsyncIterator[Rig]:
    r = Rig(db, schema)
    yield r
    await asyncio.gather(*(w.stop() for w in r.workers))
    await asyncio.gather(*(x.close() for x in r.receivers))
    await asyncio.gather(*(d.close() for d in r.extra_dbs))


async def until(check: Callable[[], Awaitable[bool] | bool], what: str, limit: float = 4.0) -> None:
    deadline = time.monotonic() + limit
    while True:
        result = check()
        if (await result) if asyncio.iscoroutine(result) else result:
            return
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out waiting for {what}")
        await asyncio.sleep(0.01)


async def test_posts_the_stored_record_with_the_idempotency_key_and_the_hook_secret_and_marks_it_delivered(
    rig: Rig,
) -> None:
    id = await rig.session_with_deliveries(1)
    rx = await rig.serve(lambda *_: 200)
    await rig.worker(rx.url).start()
    assert len(rx.received) == 1
    got = rx.received[0]
    assert (got.key, got.secret, got.content_type) == (f"{id}:1", HOOK_SECRET.reveal(), "application/json")
    assert (got.body["sessionId"], got.body["revision"]) == (id, 1)
    assert await rig.states(id) == [[1, "delivered", 1]]
    assert isinstance((await list_outbox(rig.db.pool, id))[0].delivered_at, datetime)


async def test_a_flaky_receiver_fail_fail_200_is_delivered_on_attempt_3_with_growing_waits(rig: Rig) -> None:
    id = await rig.session_with_deliveries(1)
    rx = await rig.serve(lambda _r, i: 503 if i < 2 else 200)
    await rig.worker(rx.url).start()
    await until(lambda: _is_delivered(rig, id), "delivery")
    assert len(rx.received) == 3
    assert await rig.states(id) == [[1, "delivered", 3]]
    a, b, c = (r.at for r in rx.received)
    assert b - a >= 14  # base 15 ms, full jitter (random = 1)
    assert c - b >= 28  # doubled


async def _is_delivered(rig: Rig, id: str) -> bool:
    states = await rig.states(id)
    return bool(states) and states[0][1] == "delivered"


async def test_rev_2_is_never_sent_before_rev_1_is_done_even_while_rev_1_keeps_failing(rig: Rig) -> None:
    id = await rig.session_with_deliveries(2)
    failing = True
    rx = await rig.serve(lambda *_: 500 if failing else 200)
    await rig.worker(rx.url).start()
    await until(lambda: len(rx.received) >= 3, "three failed attempts")
    assert all(r.body["revision"] == 1 for r in rx.received)  # rev 2 waited
    failing = False
    await until(lambda: _all_delivered(rig, id), "both delivered")
    assert [r.body["revision"] for r in rx.received][-2:] == [1, 2]
    order = [r.body["revision"] for r in rx.received]
    assert all(r == 2 for r in order[order.index(2) :])  # no revision 1 after the first 2


async def _all_delivered(rig: Rig, id: str) -> bool:
    return all(s[1] == "delivered" for s in await rig.states(id))


async def test_a_4xx_not_408_429_is_dead_at_once_and_releases_the_next_revision_the_error_is_kept_never_the_url_or_secret(
    rig: Rig,
) -> None:
    id = await rig.session_with_deliveries(2)
    rx = await rig.serve(lambda r, _i: 400 if r.body["revision"] == 1 else 200)
    await rig.worker(rx.url).start()

    async def rev_two_delivered() -> bool:
        states = await rig.states(id)
        return len(states) == 2 and states[1][1] == "delivered"

    await until(rev_two_delivered, "rev 2 delivered")
    one, two = await list_outbox(rig.db.pool, id)
    assert [one.status, one.attempts, one.last_error] == ["dead", 1, "HTTP 400"]
    assert two.status == "delivered"
    dumped = json.dumps([dataclasses.asdict(o) for o in await list_outbox(rig.db.pool, id)], default=str)
    assert "127.0.0.1" not in dumped
    assert "hook-secret" not in dumped


@pytest.mark.parametrize("status", [408, 429, 500, 502])
async def test_http_status_is_retried(rig: Rig, status: int) -> None:
    id = await rig.session_with_deliveries(1)
    rx = await rig.serve(lambda _r, i: status if i == 0 else 200)
    await rig.worker(rx.url).start()
    await until(lambda: _is_delivered(rig, id), "delivery")
    assert len(rx.received) == 2


async def test_gives_up_after_the_maximum_attempts_dead_with_the_last_error(rig: Rig) -> None:
    id = await rig.session_with_deliveries(1)
    rx = await rig.serve(lambda *_: 500)
    await rig.worker(rx.url, max_attempts=3).start()

    async def dead() -> bool:
        states = await rig.states(id)
        return bool(states) and states[0][1] == "dead"

    await until(dead, "dead")
    assert len(rx.received) == 3
    assert await rig.states(id) == [[1, "dead", 3]]
    assert (await list_outbox(rig.db.pool, id))[0].last_error == "HTTP 500"


async def test_a_receiver_that_never_answers_times_out_and_is_retried_a_dropped_connection_is_a_network_error(
    rig: Rig,
) -> None:
    id = await rig.session_with_deliveries(1)
    rx = await rig.serve(lambda _r, i: "hang" if i == 0 else "drop" if i == 1 else 200)
    await rig.worker(rx.url, timeout_ms=80).start()
    await until(lambda: _is_delivered(rig, id), "delivery after a timeout and a drop")
    assert len(rx.received) == 3


async def test_does_not_follow_a_redirect_the_secret_header_would_go_along_it_is_a_failure(rig: Rig) -> None:
    id = await rig.session_with_deliveries(1)
    target = await rig.serve(lambda *_: 200)
    rx = await rig.serve(lambda *_: {"redirect": target.url.reveal()})
    await rig.worker(rx.url, max_attempts=2).start()

    async def dead() -> bool:
        states = await rig.states(id)
        return bool(states) and states[0][1] == "dead"

    await until(dead, "dead")
    assert target.received == []
    assert (await list_outbox(rig.db.pool, id))[0].last_error == "HTTP 302"


async def test_notify_delivers_a_new_row_at_once_an_idle_worker_does_not_poll(rig: Rig) -> None:
    rx = await rig.serve(lambda *_: 200)
    w = rig.worker(rx.url, max_sleep_ms=60_000)
    await w.start()
    idle_queries = rig.db.stats.acquired
    await asyncio.sleep(0.3)
    assert rig.db.stats.acquired == idle_queries  # asleep: no timer, no polling
    id = await rig.session_with_deliveries(1)
    w.notify()
    await until(lambda: len(rx.received) == 1, "the nudged delivery", 1.5)
    assert rx.received[0].body["sessionId"] == id


async def test_a_stop_leaves_unfinished_rows_and_the_next_start_a_restart_delivers_them(rig: Rig) -> None:
    id = await rig.session_with_deliveries(2)
    rx = await rig.serve(lambda *_: 200)
    first = rig.worker(rx.url)
    await first.stop()  # never started: nothing delivered
    assert await rig.states(id) == [[1, "pending", 0], [2, "pending", 0]]
    await rig.worker(rx.url).start()
    assert await rig.states(id) == [[1, "delivered", 1], [2, "delivered", 1]]
    assert [r.body["revision"] for r in rx.received] == [1, 2]


async def test_a_row_leased_by_a_worker_that_died_is_delivered_again_once_the_lease_has_passed_before_that_it_is_left_alone(
    rig: Rig,
) -> None:
    id = await rig.session_with_deliveries(2)
    one = (await list_outbox(rig.db.pool, id))[0]
    lease = datetime.now(UTC) + timedelta(milliseconds=300)
    await save_outbox(
        rig.db.pool, id=one.id, status="sending", attempts=1, next_attempt_at=lease, last_error=None, delivered_at=None
    )
    rx = await rig.serve(lambda *_: 200)
    await rig.worker(rx.url).start()
    assert rx.received == []  # leased (and rev 2 waits behind it)
    await until(lambda: _all_delivered(rig, id), "delivery after the lease")
    assert [r.body["revision"] for r in rx.received] == [1, 2]
    assert (await rig.states(id))[0][2] == 2  # the dead worker's attempt counted


async def test_two_workers_two_instances_deliver_every_row_exactly_once(rig: Rig) -> None:
    ids = [await rig.session_with_deliveries(1) for _ in range(12)]
    rx = await rig.serve(lambda *_: 200)
    other = await rig.schema.open(max_size=4)
    rig.extra_dbs.append(other)
    a = rig.worker(rx.url)
    b = rig.worker(rx.url, pool=other.pool)
    await asyncio.gather(a.start(), b.start())

    async def all_delivered() -> bool:
        return all([(await rig.states(i))[0][1] == "delivered" for i in ids])

    await until(all_delivered, "all delivered")
    keys = [r.key for r in rx.received]
    assert len(set(keys)) == len(keys)
    assert len(keys) == 12


async def test_a_sessions_revisions_stay_in_order_while_two_sessions_are_delivered_in_parallel(rig: Rig) -> None:
    a = await rig.session_with_deliveries(3)
    b = await rig.session_with_deliveries(3)
    rx = await rig.serve(lambda *_: 200)
    await rig.worker(rx.url).start()

    async def all_delivered() -> bool:
        return await _all_delivered(rig, a) and await _all_delivered(rig, b)

    await until(all_delivered, "all delivered")
    for id in (a, b):
        assert [r.body["revision"] for r in rx.received if r.body["sessionId"] == id] == [1, 2, 3]

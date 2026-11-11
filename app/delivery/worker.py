"""The outbox delivery worker (P7-T03, D17): at-least-once delivery of record revisions, with the receiver's
idempotency key making the effect exactly-once.

- Event-driven, like the sweeper (D09, rev 3: no polling, so Neon can suspend): it sleeps until the earliest deliverable
  row is due, and `notify()` wakes it after a commit queued a row. A safety re-read runs at most hourly.
- A claim leases rows (`sending`, next_attempt_at = now + lease) inside a short transaction with FOR UPDATE SKIP LOCKED,
  then delivers outside it. A crash mid-delivery leaves the lease to expire, and the row is retried.
- Per session, in revision order: rev n+1 is not deliverable while rev n is pending or sending (db/repos/outbox), so a
  consumer never sees an older revision after a newer one. A dead rev n releases n+1.
- Retries: exponential backoff with jitter; 4xx other than 408/429 -> dead at once; `max_attempts` -> dead.
- Every delivered record is logged (without its signed file links, P4 review #8); a dead one is logged as an error and
  stays visible in the timeline (outbox list).
"""

from __future__ import annotations

import asyncio
import json
import math
import random as random_module
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import asyncpg
import httpx

from app.config import Secret
from app.db.repos.outbox import OutboxEntry, claim_due_outbox, earliest_outbox_due_at, save_outbox
from app.db.repos.records import get_record
from app.db.tx import transaction
from app.domain.record import without_file_urls
from app.failpoints import failpoint
from app.voice.clock import Clock, real_clock

from .http import DeliveryResult, post_record

DEFAULT_TIMEOUT_MS = 10_000


@dataclass(frozen=True, slots=True)
class Backoff:
    """Backoff after attempt n: min(cap_ms, base_ms * 2^(n-1)), then jitter to 50-100% of that."""

    base_ms: float = 2_000
    cap_ms: float = 10 * 60_000


def _at(ms: float) -> datetime:
    return datetime.fromtimestamp(ms / 1000, UTC)


class OutboxWorker:
    def __init__(
        self,
        *,
        pool: asyncpg.Pool,
        log: Any,
        url: Secret,
        hook_secret: Secret,
        client: httpx.AsyncClient | None = None,
        clock: Clock | None = None,
        random: Callable[[], float] | None = None,
        timeout_ms: float = DEFAULT_TIMEOUT_MS,
        max_attempts: int = 10,
        backoff: Backoff | None = None,
        concurrency: int = 2,
        lease_ms: float | None = None,
        max_sleep_ms: float = 60 * 60_000,
        retry_delay_ms: float = 5_000,
    ) -> None:
        """`client` is the httpx client to deliver with (tests pass one on a mock or ASGI transport); without one the
        worker makes its own and closes it in `stop()`. `random` is in [0, 1) for the backoff jitter."""
        self._pool = pool
        self._log = log
        self._url = url
        self._hook_secret = hook_secret
        self._client = client
        self._owns_client = False
        self._clock: Clock = clock or real_clock
        self._random = random or random_module.random
        self._timeout_ms = timeout_ms
        self._max_attempts = max_attempts
        self._backoff = backoff or Backoff()
        self._concurrency = concurrency
        self._lease_ms = lease_ms if lease_ms is not None else timeout_ms + 20_000
        self._max_sleep_ms = max_sleep_ms
        self._retry_delay_ms = retry_delay_ms
        self._handle: Any = None
        self._running: asyncio.Task[None] | None = None
        self._again = False
        self._stopped = True
        self._background: set[asyncio.Task[Any]] = set()

    async def start(self) -> None:
        """Starts the worker: whatever is already due (rows left by a stop or crash) is delivered now."""
        self._stopped = False
        await self._run()

    def notify(self) -> None:
        """A command committed a new outbox row: deliver it now. No query unless the worker is idle."""
        if self._stopped:
            return
        task = self._run()
        if task not in self._background:
            self._background.add(task)
            task.add_done_callback(self._finished)

    def _finished(self, task: asyncio.Task[Any]) -> None:
        self._background.discard(task)
        if not task.cancelled() and (err := task.exception()) is not None:
            self._log.error("outbox worker failed", err=str(err))

    async def stop(self) -> None:
        """Stops waking up and waits for deliveries in flight (their rows are saved before this returns)."""
        self._stopped = True
        if self._handle is not None:
            self._clock.clear_timeout(self._handle)
        self._handle = None
        running = self._running
        if running is not None:
            await asyncio.shield(running)
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None
            self._owns_client = False

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(follow_redirects=False)
            self._owns_client = True
        return self._client

    def _run(self) -> asyncio.Task[None]:
        """One drain at a time; a call while one runs makes it go around once more."""
        if self._running is not None:
            self._again = True
            return self._running
        self._running = asyncio.ensure_future(self._loop())
        return self._running

    async def _loop(self) -> None:
        try:
            while True:
                self._again = False
                await self._drain()
                if not (self._again and not self._stopped):
                    break
        finally:
            self._running = None
        await self._sleep_until_next()

    async def _drain(self) -> None:
        while not self._stopped:
            try:
                claimed = await self._claim()
            except Exception as err:
                self._log.error(
                    "outbox claim failed",
                    code=getattr(err, "sqlstate", None) or getattr(err, "code", None),
                    err=str(err),
                )
                return
            if not claimed:
                return
            await asyncio.gather(*(self._deliver(row) for row in claimed))

    async def _claim(self) -> list[OutboxEntry]:
        """Leases the due rows: `sending`, held until now + lease, with the attempt counted (a crash can't loop forever)."""
        now_ms = self._clock.now()
        now = _at(now_ms)
        async with transaction(self._pool) as tx:
            rows = await claim_due_outbox(tx, now=now, limit=self._concurrency)
            leased: list[OutboxEntry] = []
            for row in rows:
                saved = await save_outbox(
                    tx,
                    id=row.id,
                    status="sending",
                    attempts=row.attempts + 1,
                    next_attempt_at=now + timedelta(milliseconds=self._lease_ms),
                    last_error=row.last_error,
                    delivered_at=None,
                )
                if saved is not None:
                    leased.append(saved)
            return leased

    async def _deliver(self, row: OutboxEntry) -> None:
        log = self._log.bind(sessionId=row.session_id, revision=row.revision, attempt=row.attempts)
        try:
            record = await get_record(self._pool, row.session_id, row.revision)
            # The FK guarantees the record exists; if it somehow doesn't, retrying can't help.
            if record is not None:
                result = await post_record(
                    url=self._url,
                    hook_secret=self._hook_secret,
                    idempotency_key=f"{row.session_id}:{row.revision}",
                    body=json.dumps(record.payload, separators=(",", ":"), ensure_ascii=False),
                    timeout_ms=self._timeout_ms,
                    client=self._http(),
                )
            else:
                result = DeliveryResult("dead", "record not found")
            now = _at(self._clock.now())
            if result.kind == "delivered":
                failpoint("delivery.afterPost")  # chaos tests: the receiver has it, the row doesn't say so yet
                await save_outbox(
                    self._pool,
                    id=row.id,
                    status="delivered",
                    attempts=row.attempts,
                    next_attempt_at=now,
                    last_error=None,
                    delivered_at=now,
                )
                # The brief allows logging as delivery; every delivered record is logged, without its signed links.
                log.info("record delivered", record=without_file_urls(record.payload if record else None))
                return
            dead = result.kind == "dead" or row.attempts >= self._max_attempts
            delay_ms = 0 if dead else self._delay(row.attempts)
            next_at = now + timedelta(milliseconds=delay_ms)
            await save_outbox(
                self._pool,
                id=row.id,
                status="dead" if dead else "pending",
                attempts=row.attempts,
                next_attempt_at=next_at,
                last_error=result.error,
                delivered_at=None,
            )
            if dead:
                log.error("record delivery failed for good (dead)", error=result.error)
            else:
                log.warning("record delivery failed; will retry", error=result.error, retryInMs=delay_ms)
        except Exception as err:
            # The row stays leased (`sending`) and is picked up again when the lease expires.
            log.error(
                "outbox delivery bookkeeping failed",
                code=getattr(err, "sqlstate", None) or getattr(err, "code", None),
                err=str(err),
            )

    def _delay(self, attempt: int) -> int:
        exponential = min(self._backoff.cap_ms, self._backoff.base_ms * 2 ** (attempt - 1))
        return math.floor(exponential * (0.5 + self._random() * 0.5) + 0.5)

    async def _sleep_until_next(self) -> None:
        """Sleeps until the next deliverable row is due (or the safety re-read); notify() wakes it earlier."""
        if self._stopped:
            return
        delay = self._max_sleep_ms
        try:
            due = await earliest_outbox_due_at(self._pool)
            if due is not None:
                delay = min(self._max_sleep_ms, max(0, due.timestamp() * 1000 - self._clock.now()))
        except Exception as err:
            self._log.error(
                "outbox schedule read failed",
                code=getattr(err, "sqlstate", None) or getattr(err, "code", None),
                err=str(err),
            )
            delay = self._retry_delay_ms
        if self._stopped:
            return
        if self._handle is not None:
            self._clock.clear_timeout(self._handle)

        def wake() -> None:
            self._handle = None
            task = self._run()
            if task not in self._background:
                self._background.add(task)
                task.add_done_callback(self._finished)

        self._handle = self._clock.set_timeout(wake, delay)

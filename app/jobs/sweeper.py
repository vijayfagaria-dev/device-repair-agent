"""The timer sweeper (P3-T05, D16): fires persisted timers by dispatching TimerFired commands.

No polling (rev 3, Neon compute budget, D09): it keeps the earliest known due time in memory and sleeps until then.
- start(): one `SELECT min(due_at)`; overdue timers (the deadline passed while the server was down) fire at once.
- notify(due_at): the command processor reports every timer it commits; an earlier one moves the wake-up forward. No query.
- On waking: read a batch of due timers (FOR UPDATE SKIP LOCKED, so two instances reading at the same moment split the
  batch; the row locks end with that short transaction, before firing), dispatch TimerFired for each, then read the next
  due time and sleep again. Exactly-once comes from TimerFired itself: it re-checks the timer under the session lock and
  removes it, so a second sweeper holding the same timer gets a no-op. A timer stays in the table until TimerFired
  commits, so a crash mid-sweep loses nothing: it fires on the next boot.
- A safety re-read runs at most once an hour (timers written by another instance, clock drift).
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any

from app.db.repos.timers import Timer, claim_due_timers, earliest_timer_due_at
from app.db.tx import transaction
from app.session.commands import CommandProcessor, SessionNotFoundError
from app.session.handlers.timers import TimerFired
from app.voice.clock import Clock, real_clock

#: The sweeper's clock is the call engine's: ``now()`` in ms, ``set_timeout(fn, ms)``, ``clear_timeout(handle)``.
SweeperClock = Clock

SAFETY_REREAD_MS = 60 * 60 * 1000


def _earlier(a: float | None, b: float | None) -> float | None:
    """The earlier of two due times (None = none)."""
    if a is None:
        return b
    if b is None:
        return a
    return min(a, b)


class _Read:
    """A min(due_at) read in flight, with the earliest notify() received meanwhile."""

    __slots__ = ("notified",)

    def __init__(self) -> None:
        self.notified: float | None = None


class Sweeper:
    def __init__(
        self,
        *,
        pool: Any,
        processor: CommandProcessor,
        log: Any,
        clock: SweeperClock | None = None,
        batch_size: int = 50,
        max_sleep_ms: float = SAFETY_REREAD_MS,
        retry_delay_ms: float = 30_000,
    ) -> None:
        """`batch_size`: timers claimed per batch. `max_sleep_ms`: the longest sleep (the safety re-read interval).
        `retry_delay_ms`: the wait before trying again after a database error."""
        self._pool = pool
        self._processor = processor
        self._log = log
        self._clock: SweeperClock = clock or real_clock
        self._batch_size = batch_size
        self._max_sleep_ms = max_sleep_ms
        self._retry_delay_ms = retry_delay_ms
        #: The earliest due time this process knows of (ms), or None for none.
        self._next_due: float | None = None
        self._handle: Any = None
        self._wake_at: float | None = None
        self._sweeping: asyncio.Task[None] | None = None
        self._sweep_again = False
        self._stopped = True
        #: The min(due_at) reads in flight, each with the earliest notify() received meanwhile. A read's snapshot can
        #: predate a timer committed (and notified) while it runs, so its result is combined with those notifications
        #: instead of overwriting them (else that timer would wait for the hourly re-read).
        self._reads: set[_Read] = set()
        self._background: set[asyncio.Task[None]] = set()

    async def start(self) -> None:
        """Reads the earliest due time once and schedules the first wake-up (immediately if a timer is already overdue)."""
        self._stopped = False
        self._next_due = await self._read_next_due()
        self._schedule()

    def notify(self, due_at: datetime) -> None:
        """A command committed a timer due at `due_at`: wake up earlier if needed. Never queries."""
        due = due_at.timestamp() * 1000
        for read in self._reads:
            read.notified = _earlier(read.notified, due)
        if self._next_due is not None and self._next_due <= due:
            return
        self._next_due = due
        if not self._stopped:
            self._schedule()

    async def stop(self) -> None:
        """Stops scheduling and waits for a sweep in progress."""
        self._stopped = True
        self._cancel_wake()
        if self._sweeping is not None:
            await asyncio.shield(self._sweeping)

    async def settled(self) -> None:
        """Resolves when the sweep in progress (if any) is done; never starts one."""
        while self._sweeping is not None:
            await asyncio.shield(self._sweeping)

    async def sweep(self) -> None:
        """Runs one sweep now (also what a wake-up runs); resolves when it and any sweep it queued are done."""
        if self._sweeping is not None:
            self._sweep_again = True
            await asyncio.shield(self._sweeping)
            return
        task = asyncio.ensure_future(self._run())
        self._sweeping = task

        def done(_task: asyncio.Task[None]) -> None:
            if self._sweeping is task:
                self._sweeping = None

        task.add_done_callback(done)
        await asyncio.shield(task)

    async def _run(self) -> None:
        while True:
            self._sweep_again = False
            try:
                failed = await self._fire_due()
                self._next_due = await self._read_next_due()
                # A timer whose command failed is still due: come back after the retry delay, not at once (no busy loop).
                self._schedule(self._retry_delay_ms if failed > 0 else None)
            except Exception as err:
                self._log.error("timer sweep failed; retrying", code=getattr(err, "sqlstate", None), message=str(err))
                self._schedule(self._retry_delay_ms)
            if not (self._sweep_again and not self._stopped):
                return

    async def _read_next_due(self) -> float | None:
        """The earliest due time: the database's, or an earlier one notified while the query ran."""
        read = _Read()
        self._reads.add(read)
        try:
            earliest = await earliest_timer_due_at(self._pool)
            return _earlier(earliest.timestamp() * 1000 if earliest is not None else None, read.notified)
        finally:
            self._reads.discard(read)

    async def _fire_due(self) -> int:
        """Fires every due timer, batch by batch; returns how many failed (they stay due and are retried later)."""
        failed = 0
        while True:
            now = datetime.fromtimestamp(self._clock.now() / 1000, UTC)
            async with transaction(self._pool) as tx:
                due = await claim_due_timers(tx, now=now, limit=self._batch_size)
            for timer in due:
                # Shutting down: leave the rest for the next boot (they stay in the table) instead of delaying exit.
                if self._stopped:
                    return failed
                if not await self._fire(timer):
                    failed += 1
            # A failed timer would be read again at once; stop and let the retry delay pass first.
            if len(due) < self._batch_size or failed > 0 or self._stopped:
                return failed

    async def _fire(self, timer: Timer) -> bool:
        """Dispatches TimerFired for one timer. A failure is logged and doesn't stop the others: one session whose command
        keeps failing must not hold up every other session's deadlines."""
        command = TimerFired(kind=timer.kind, due_at=timer.due_at)
        try:
            result = await self._processor.dispatch(timer.session_id, command)
        except Exception as err:
            # A session row always exists for its timers (foreign key), so a missing one is a bug, as is any other failure.
            if isinstance(err, SessionNotFoundError):
                self._log.error("timer for a missing session", session_id=timer.session_id, kind=timer.kind)
            else:
                self._log.error(
                    "timer command failed; retrying later",
                    session_id=timer.session_id,
                    kind=timer.kind,
                    code=getattr(err, "sqlstate", None),
                    message=str(err),
                )
            return False
        self._log.info("timer handled", session_id=timer.session_id, kind=timer.kind, reply=result.reply)
        return True

    def _schedule(self, delay_ms: float | None = None) -> None:
        """Sleeps until the next due time, at most `max_sleep_ms` (the hourly safety re-read). `delay_ms` (after an error)
        is used as is: an overdue timer that keeps failing must not turn into a busy loop against the database."""
        if self._stopped:
            return
        now = self._clock.now()
        until_due = self._max_sleep_ms if self._next_due is None else max(0, self._next_due - now)
        wake_at = now + (delay_ms if delay_ms is not None else min(until_due, self._max_sleep_ms))
        if self._handle is not None and self._wake_at == wake_at:
            return
        self._cancel_wake()
        self._wake_at = wake_at

        def wake() -> None:
            self._handle = None
            self._wake_at = None
            task = asyncio.ensure_future(self.sweep())
            self._background.add(task)
            task.add_done_callback(self._background.discard)

        self._handle = self._clock.set_timeout(wake, wake_at - now)

    def _cancel_wake(self) -> None:
        if self._handle is not None:
            self._clock.clear_timeout(self._handle)
        self._handle = None
        self._wake_at = None

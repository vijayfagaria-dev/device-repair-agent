"""The clock the call engine runs on: real timers in production, a manual clock in tests.

Call-scoped timers such as the silence reprompt live in memory (D16); they die with the call. Timer callbacks may be
plain functions or coroutine functions (a coroutine is run as a task on the loop).
"""

from __future__ import annotations

import asyncio
import inspect
import time
from collections.abc import Callable
from typing import Any, Protocol

TimerFn = Callable[[], Any]


class Clock(Protocol):
    def now(self) -> float:
        """Milliseconds."""
        ...

    def set_timeout(self, fn: TimerFn, ms: float) -> Any: ...

    def clear_timeout(self, handle: Any) -> None: ...


_background: set[asyncio.Task[Any]] = set()


def _run(fn: TimerFn) -> None:
    result = fn()
    if inspect.isawaitable(result):
        task = asyncio.ensure_future(result)
        _background.add(task)
        task.add_done_callback(_background.discard)


class RealClock:
    """Wall-clock time on the running event loop."""

    def now(self) -> float:
        return time.time() * 1000

    def set_timeout(self, fn: TimerFn, ms: float) -> asyncio.TimerHandle:
        return asyncio.get_running_loop().call_later(max(0.0, ms) / 1000, _run, fn)

    def clear_timeout(self, handle: Any) -> None:
        if handle is not None:
            handle.cancel()


real_clock = RealClock()


class _Timer:
    __slots__ = ("at", "fn", "id")

    def __init__(self, id_: int, at: float, fn: TimerFn) -> None:
        self.id = id_
        self.at = at
        self.fn = fn


class ManualClock:
    """A clock tests advance by hand; timers fire in due order, each at its own ``now``."""

    def __init__(self, start: float = 1_700_000_000_000) -> None:
        self._now = start
        self._next = 1
        self._timers: dict[int, _Timer] = {}

    def now(self) -> float:
        return self._now

    def set_timeout(self, fn: TimerFn, ms: float) -> int:
        id_ = self._next
        self._next += 1
        self._timers[id_] = _Timer(id_, self._now + max(0, ms), fn)
        return id_

    def clear_timeout(self, handle: Any) -> None:
        self._timers.pop(handle, None)

    def advance(self, ms: float) -> None:
        """Moves time forward, firing every timer due on the way (including ones those timers set).

        Synchronous: coroutine callbacks are started as tasks (they run when the test next awaits).
        """
        end = self._now + ms
        while True:
            due: _Timer | None = None
            for timer in self._timers.values():
                if timer.at <= end and (due is None or timer.at < due.at):
                    due = timer
            if due is None:
                break
            del self._timers[due.id]
            self._now = due.at
            _run(due.fn)
        self._now = end

    async def tick(self, ms: float, *, every: float = 20, settle: int = 5) -> None:
        """Advances in steps of ``every`` ms, letting async work run between steps (the tests' ``step``)."""
        elapsed = 0.0
        while elapsed < ms:
            self.advance(min(every, ms - elapsed))
            elapsed += every
            await settle_loop(settle)

    @property
    def pending(self) -> int:
        return len(self._timers)


async def settle_loop(rounds: int = 5) -> None:
    """Lets the event loop run other ready tasks (the TS tests' ``setImmediate`` flush)."""
    for _ in range(rounds):
        await asyncio.sleep(0)

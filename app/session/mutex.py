"""Per-key async mutex (D11): work for one session runs strictly one at a time inside this process.

It is only the fast path: the `FOR UPDATE` session row lock taken first in every command transaction (D09) is what
keeps commands ordered across two processes (a deploy overlap). One `asyncio.Lock` per key (FIFO), reference-counted
so an idle key costs nothing.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable


class _Entry:
    __slots__ = ("holders", "lock")

    def __init__(self) -> None:
        self.lock = asyncio.Lock()
        self.holders = 0


class KeyedMutex:
    def __init__(self) -> None:
        self._entries: dict[str, _Entry] = {}

    async def run[T](self, key: str, fn: Callable[[], Awaitable[T]]) -> T:
        """Runs `fn` once every earlier `run` for `key` has finished (FIFO). The lock is released before the returned
        awaitable settles, so a caller that awaits `run` and then dispatches more work for the key never waits on itself."""
        entry = self._entries.get(key)
        if entry is None:
            entry = self._entries[key] = _Entry()
        entry.holders += 1
        try:
            async with entry.lock:
                return await fn()
        finally:
            entry.holders -= 1
            if entry.holders == 0 and self._entries.get(key) is entry:
                del self._entries[key]

    @property
    def size(self) -> int:
        """Keys with a holder or waiters (for tests and leak checks)."""
        return len(self._entries)

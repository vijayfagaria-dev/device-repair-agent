"""A pool whose statements call a hook before and after they run (the TS tests' `hookPool` Proxy): on the pool itself
and on the connections checked out of it (transactions, including their BEGIN)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

Hook = Callable[[str, tuple[Any, ...] | None, str], Awaitable[None]]

_BEGIN_SNAPSHOT = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"


class _HookedTransaction:
    def __init__(self, inner: Any, hook: Hook, text: str) -> None:
        self._inner = inner
        self._hook = hook
        self._text = text

    async def __aenter__(self) -> Any:
        await self._hook(self._text, None, "before")
        result = await self._inner.__aenter__()
        await self._hook(self._text, None, "after")
        return result

    async def __aexit__(self, *exc: Any) -> Any:
        return await self._inner.__aexit__(*exc)


class _HookedConnection:
    def __init__(self, conn: Any, hook: Hook) -> None:
        self._conn = conn
        self._hook = hook

    def transaction(self, *, isolation: str | None = None, readonly: bool = False, **kwargs: Any) -> Any:
        inner = self._conn.transaction(isolation=isolation, readonly=readonly, **kwargs)
        text = _BEGIN_SNAPSHOT if isolation == "repeatable_read" and readonly else "BEGIN"
        return _HookedTransaction(inner, self._hook, text)

    def __getattr__(self, name: str) -> Any:
        value = getattr(self._conn, name)
        if name in ("fetch", "fetchrow", "fetchval", "execute"):

            async def hooked(query: str, *args: Any, **kwargs: Any) -> Any:
                await self._hook(query, args, "before")
                result = await value(query, *args, **kwargs)
                await self._hook(query, args, "after")
                return result

            return hooked
        return value


class _HookedAcquire:
    def __init__(self, inner: Any, hook: Hook) -> None:
        self._inner = inner
        self._hook = hook

    async def __aenter__(self) -> _HookedConnection:
        return _HookedConnection(await self._inner.__aenter__(), self._hook)

    async def __aexit__(self, *exc: Any) -> Any:
        return await self._inner.__aexit__(*exc)


class HookedPool:
    def __init__(self, pool: Any, hook: Hook) -> None:
        self._pool = pool
        self._hook = hook

    def acquire(self, *args: Any, **kwargs: Any) -> _HookedAcquire:
        return _HookedAcquire(self._pool.acquire(*args, **kwargs), self._hook)

    def __getattr__(self, name: str) -> Any:
        value = getattr(self._pool, name)
        if name in ("fetch", "fetchrow", "fetchval", "execute"):

            async def hooked(query: str, *args: Any, **kwargs: Any) -> Any:
                await self._hook(query, args, "before")
                result = await value(query, *args, **kwargs)
                await self._hook(query, args, "after")
                return result

            return hooked
        return value

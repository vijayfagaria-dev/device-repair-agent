"""Transactions. One pooled connection runs BEGIN ... COMMIT, or ROLLBACK on any error, and is always released.

Work that is only correct inside a transaction (row locks, event sequence numbers, SKIP LOCKED claims) takes a
`Tx`, which only `transaction()` creates, so calling it on the pool is a type error.

    async with transaction(db.pool) as tx:
        await tx.fetchrow("SELECT ... FOR UPDATE", session_id)
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from typing import Any, Protocol

import asyncpg

from .pool import TIMEOUT_MS

#: Server-side limit for each statement in a transaction. Neon's pooler ignores a startup `statement_timeout`, so it
#: is set per transaction, below the pool's client-side command timeout so the server cancels a slow statement first.
TX_STATEMENT_TIMEOUT_MS = TIMEOUT_MS - 1_000


class Queryable(Protocol):
    """Anything that runs a parameterized query: the pool (autocommit) or an open transaction."""

    async def fetch(self, query: str, *args: Any) -> list[asyncpg.Record]: ...
    async def fetchrow(self, query: str, *args: Any) -> asyncpg.Record | None: ...
    async def fetchval(self, query: str, *args: Any) -> Any: ...
    async def execute(self, query: str, *args: Any) -> str: ...


class Tx:
    """An open transaction. Created only by `transaction()`; unusable once it has committed or rolled back."""

    def __init__(self, conn: asyncpg.Connection) -> None:
        self._conn: asyncpg.Connection | None = conn

    def _live(self) -> asyncpg.Connection:
        if self._conn is None:
            raise RuntimeError("Transaction is already finished; queries must run inside transaction()")
        return self._conn

    async def fetch(self, query: str, *args: Any) -> list[asyncpg.Record]:
        return await self._live().fetch(query, *args)

    async def fetchrow(self, query: str, *args: Any) -> asyncpg.Record | None:
        return await self._live().fetchrow(query, *args)

    async def fetchval(self, query: str, *args: Any) -> Any:
        return await self._live().fetchval(query, *args)

    async def execute(self, query: str, *args: Any) -> str:
        return await self._live().execute(query, *args)

    async def executemany(self, query: str, args: Sequence[Sequence[Any]]) -> None:
        await self._live().executemany(query, args)

    def _close(self) -> None:
        self._conn = None


@asynccontextmanager
async def transaction(
    pool: asyncpg.Pool,
    *,
    statement_timeout_ms: int | None = None,
    snapshot: bool = False,
) -> AsyncIterator[Tx]:
    """Runs the body in one transaction on one pooled connection.

    Commits when the body finishes; rolls back and re-raises when the body (or COMMIT) fails. `snapshot=True` gives
    one read-only snapshot for every statement (REPEATABLE READ READ ONLY): reads that must agree with each other,
    such as a chat replay. It takes no locks and never blocks or fails a writer. Not reentrant: never open a
    transaction inside another (it would take a second connection and could deadlock on a lock).
    """
    timeout_ms = TX_STATEMENT_TIMEOUT_MS if statement_timeout_ms is None else statement_timeout_ms
    if not isinstance(timeout_ms, int) or timeout_ms < 1 or timeout_ms > TX_STATEMENT_TIMEOUT_MS:
        raise ValueError(f"statement_timeout_ms must be an integer from 1 to {TX_STATEMENT_TIMEOUT_MS}")
    async with pool.acquire() as conn:
        tx = Tx(conn)
        try:
            async with conn.transaction(
                isolation="repeatable_read" if snapshot else "read_committed", readonly=snapshot
            ):
                # set_config(..., true) is SET LOCAL with a bound parameter: it ends with the transaction.
                await conn.execute("SELECT set_config('statement_timeout', $1, true)", f"{timeout_ms}ms")
                yield tx
        finally:
            tx._close()

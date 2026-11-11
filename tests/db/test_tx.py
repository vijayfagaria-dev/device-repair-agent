"""Port of server/test/tx.test.ts: transaction() and lock_session against a real Postgres: commit, rollback, connection
release, timeouts, broken connections, and per-session serialization across concurrent transactions. (The TS
compile-time `Tx` type checks have no runtime equivalent; `Tx` is only created by `transaction()`.)"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import asyncpg
import pytest

from app.db.repos.chat_messages import insert_chat_message
from app.db.repos.events import append_event, list_events
from app.db.repos.sessions import get_session, lock_session
from app.db.tx import TX_STATEMENT_TIMEOUT_MS, Tx, transaction
from tests.repos.seed import seed_session


async def count(pool: asyncpg.Pool, table: str, session_id: str) -> int:
    return int(await pool.fetchval(f"SELECT count(*)::int FROM {table} WHERE session_id = $1", session_id))


def expect_pool_settled(pool: asyncpg.Pool) -> None:
    """Every connection is back in the pool."""
    assert pool.get_idle_size() == pool.get_size()


class TestTransaction:
    async def test_commits_and_returns_the_callbacks_value(self, db: Any) -> None:
        id = await seed_session(db.pool)
        async with transaction(db.pool) as tx:
            await lock_session(tx, id)
            seq = (await append_event(tx, session_id=id, type="a", channel="system")).seq
        assert seq == 1
        assert await count(db.pool, "events", id) == 1
        expect_pool_settled(db.pool)

    async def test_raising_inside_leaves_zero_rows_and_releases_the_connection(self, db: Any) -> None:
        pool = db.pool
        await pool.fetchval("SELECT 1")  # warm: one idle connection
        idle_before, total_before = pool.get_idle_size(), pool.get_size()
        id = "6f1c1f9e-4d55-4a43-9a51-0a8f6b1c2d3e"
        with pytest.raises(RuntimeError, match="boom"):
            async with transaction(pool) as tx:
                await tx.execute("INSERT INTO sessions (id) VALUES ($1)", id)
                await append_event(tx, session_id=id, type="a", channel="system")
                await tx.execute(
                    "INSERT INTO records (session_id, revision, outcome, payload, content_hash) "
                    "VALUES ($1, 1, 'partial', '{}', $2)",
                    id,
                    "f" * 64,
                )
                assert pool.get_idle_size() == idle_before - 1  # the transaction holds the connection
                raise RuntimeError("boom")
        assert await get_session(pool, id) is None
        assert await count(pool, "events", id) == 0
        assert await count(pool, "records", id) == 0
        assert pool.get_idle_size() == idle_before
        assert pool.get_size() == total_before
        expect_pool_settled(pool)

    async def test_does_not_leak_connections_40_concurrent_failing_transactions_on_a_pool_of_5(self, db: Any) -> None:
        pool = db.pool

        async def work(i: int) -> None:
            async with transaction(pool) as tx:
                await tx.fetchval("SELECT 1")
                if i % 2 == 0:
                    raise RuntimeError(f"fail {i}")
                await tx.fetchval("SELECT 1/0")  # a SQL error fails the other half

        results = await asyncio.gather(*(work(i) for i in range(40)), return_exceptions=True)
        assert all(isinstance(r, Exception) for r in results)
        assert pool.get_size() <= 5
        expect_pool_settled(pool)
        async with transaction(pool) as tx:
            assert await tx.fetchval("SELECT 1 AS ok") == 1

    async def test_rolls_back_when_commit_fails_a_deferred_foreign_key_and_releases_the_connection(
        self, db: Any
    ) -> None:
        id = await seed_session(db.pool)
        with pytest.raises(asyncpg.ForeignKeyViolationError) as info:
            async with transaction(db.pool) as tx:
                await insert_chat_message(tx, id="m_orphan", session_id=id, event_seq=99, role="user", text="hi")
        assert info.value.sqlstate == "23503"
        assert await count(db.pool, "chat_messages", id) == 0
        expect_pool_settled(db.pool)

    async def test_sets_a_transaction_local_statement_timeout_that_ends_with_the_transaction(self, schema: Any) -> None:
        single = await schema.open(max_size=1)  # one connection, so the check after the transaction reuses it
        try:
            async with transaction(single.pool) as tx:
                inside = await tx.fetchval("SELECT current_setting('statement_timeout')")
            assert inside == f"{TX_STATEMENT_TIMEOUT_MS // 1000}s"
            after = await single.pool.fetchval("SELECT current_setting('statement_timeout')")
            assert after != inside
        finally:
            await single.close()

    async def test_cancels_a_statement_that_exceeds_the_timeout_57014_and_returns_the_connection(self, db: Any) -> None:
        started = time.monotonic()
        with pytest.raises(asyncpg.QueryCanceledError) as info:
            async with transaction(db.pool, statement_timeout_ms=200) as tx:
                await tx.execute("SELECT pg_sleep(5)")
        assert info.value.sqlstate == "57014"
        assert time.monotonic() - started < 3
        expect_pool_settled(db.pool)

    async def test_rejects_an_invalid_timeout_before_taking_a_connection(self, db: Any) -> None:
        before = db.stats.acquired
        for bad in [0, -1, 1.5, TX_STATEMENT_TIMEOUT_MS + 1]:
            with pytest.raises(ValueError):
                async with transaction(db.pool, statement_timeout_ms=bad):  # type: ignore[arg-type]
                    pass
        assert db.stats.acquired == before

    async def test_destroys_the_connection_when_it_dies_mid_transaction_the_pool_keeps_working(self, db: Any) -> None:
        id = await seed_session(db.pool)
        with pytest.raises(Exception):  # noqa: B017
            async with transaction(db.pool) as tx:
                await tx.execute(
                    "INSERT INTO usage (session_id, provider, kind, units, unit) VALUES ($1, 'x', 'y', 1, 'z')", id
                )
                pid = await tx.fetchval("SELECT pg_backend_pid()")
                await db.pool.fetchval("SELECT pg_terminate_backend($1)", pid)  # from another connection
                await asyncio.sleep(0.2)
                await tx.fetchval("SELECT 1")
        assert await count(db.pool, "usage", id) == 0
        expect_pool_settled(db.pool)
        assert await db.pool.fetchval("SELECT 1 AS ok") == 1

    async def test_the_tx_handle_is_unusable_after_the_transaction_ends(self, db: Any) -> None:
        escaped: Tx
        async with transaction(db.pool) as tx:
            escaped = tx
        with pytest.raises(RuntimeError, match="already finished"):
            await escaped.fetchval("SELECT 1")


class TestLockSession:
    async def test_returns_the_locked_session_or_none_for_an_unknown_id(self, db: Any) -> None:
        id = await seed_session(db.pool)
        async with transaction(db.pool) as tx:
            locked = await lock_session(tx, id)
            assert locked is not None
            assert locked.id == id
            assert await lock_session(tx, "00000000-0000-4000-8000-000000000000") is None

    async def test_two_concurrent_transactions_that_lock_the_same_session_run_one_after_the_other(
        self, db: Any
    ) -> None:
        id = await seed_session(db.pool)
        log: list[str] = []
        a_has_lock = asyncio.Event()

        async def a() -> None:
            async with transaction(db.pool) as tx:
                await lock_session(tx, id)
                log.append("A locked")
                a_has_lock.set()
                await asyncio.sleep(0.3)
                await append_event(tx, session_id=id, type="from.a", channel="system")
                log.append("A done")

        async def b() -> tuple[float, list[str]]:
            started = time.monotonic()
            async with transaction(db.pool) as tx:
                await lock_session(tx, id)
                log.append("B locked")
                # B sees A's committed write: it only got the lock after A's COMMIT.
                return time.monotonic() - started, [e.type for e in await list_events(tx, id)]

        task_a = asyncio.create_task(a())
        await a_has_lock.wait()
        waited, events = await b()
        await task_a
        assert log == ["A locked", "A done", "B locked"]
        assert events == ["from.a"]
        assert waited >= 0.2

    async def test_locks_on_different_sessions_dont_block_each_other(self, db: Any) -> None:
        s1, s2 = await seed_session(db.pool), await seed_session(db.pool)
        log: list[str] = []
        a_has_lock = asyncio.Event()

        async def a() -> None:
            async with transaction(db.pool) as tx:
                await lock_session(tx, s1)
                a_has_lock.set()
                await asyncio.sleep(0.3)
                log.append("A done")

        async def b() -> None:
            async with transaction(db.pool) as tx:
                await lock_session(tx, s2)
                log.append("B done")

        task_a = asyncio.create_task(a())
        await a_has_lock.wait()
        await b()
        await task_a
        assert log == ["B done", "A done"]

    async def test_serializes_event_appends_50_concurrent_locked_appends_get_seq_1_to_50_with_no_failures(
        self, db: Any
    ) -> None:
        id = await seed_session(db.pool)

        async def append(i: int) -> int:
            async with transaction(db.pool) as tx:
                await lock_session(tx, id)
                return (await append_event(tx, session_id=id, type=f"e{i}", channel="system")).seq

        seqs = await asyncio.gather(*(append(i) for i in range(50)))
        assert sorted(seqs) == list(range(1, 51))
        assert [e.seq for e in await list_events(db.pool, id)] == list(range(1, 51))
        expect_pool_settled(db.pool)

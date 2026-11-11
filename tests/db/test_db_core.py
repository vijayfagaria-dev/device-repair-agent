"""The database core: pool settings, transactions, migrations."""

import asyncio

import pytest

from app.db.migrate import load_migrations, migrate
from app.db.pool import connection_settings, is_transient_db_error
from app.db.tx import TX_STATEMENT_TIMEOUT_MS, transaction


def test_local_host_without_sslmode_is_plain_and_remote_verifies():
    assert connection_settings("postgresql://u@127.0.0.1:5432/db")[1] is False
    assert connection_settings("postgresql://u@h.neon.tech/db?sslmode=require")[1] is not False
    dsn, ssl = connection_settings("postgresql://u@h.neon.tech/db?sslmode=disable&x=1")
    assert ssl is False and "sslmode" not in dsn and "x=1" in dsn


async def test_migrations_apply_once_and_create_the_schema(schema):
    again = await migrate(schema.db.pool)
    assert again.applied == []
    tables = {
        r["table_name"]
        for r in await schema.db.pool.fetch(
            "select table_name from information_schema.tables where table_schema = current_schema()"
        )
    }
    assert {"sessions", "events", "records", "outbox", "schema_migrations"} <= tables


def test_migration_files_are_contiguous():
    assert [m.version for m in load_migrations()] == list(range(1, len(load_migrations()) + 1))


async def test_concurrent_boots_apply_each_migration_once(test_database_url):
    from tests.helpers.db import create_migrated_schema

    s = await create_migrated_schema(test_database_url, "m")
    try:
        results = await asyncio.gather(*[migrate(s.db.pool) for _ in range(4)])
        assert all(r.applied == [] for r in results)
        assert await s.db.pool.fetchval("select count(*) from schema_migrations") == len(load_migrations())
    finally:
        await s.drop()


async def test_transaction_commits_rolls_back_and_guards_late_use(db):
    async with transaction(db.pool) as tx:
        await tx.execute("create temp table t_probe (n int)")
    with pytest.raises(RuntimeError, match="boom"):
        async with transaction(db.pool) as tx:
            await tx.execute("insert into sessions (id) values (gen_random_uuid())")
            raise RuntimeError("boom")
    assert await db.pool.fetchval("select count(*) from sessions") == 0
    async with transaction(db.pool) as tx:
        pass
    with pytest.raises(RuntimeError, match="already finished"):
        await tx.fetch("select 1")


async def test_transaction_rejects_a_bad_statement_timeout_and_supports_snapshots(db):
    for bad in (0, TX_STATEMENT_TIMEOUT_MS + 1):
        with pytest.raises(ValueError):
            async with transaction(db.pool, statement_timeout_ms=bad):
                pass
    async with transaction(db.pool, snapshot=True) as tx:
        assert await tx.fetchval("select 1") == 1
        with pytest.raises(Exception, match="read-only"):
            await tx.execute("insert into sessions (id) values (gen_random_uuid())")


async def test_jsonb_and_uuid_round_trip_as_python_values(db):
    row = await db.pool.fetchrow("select $1::jsonb as j, gen_random_uuid() as u", {"a": [1, 2]})
    assert row["j"] == {"a": [1, 2]} and isinstance(row["u"], str)


def test_transient_error_detection():
    assert is_transient_db_error(ConnectionResetError())
    assert not is_transient_db_error(ValueError("x"))

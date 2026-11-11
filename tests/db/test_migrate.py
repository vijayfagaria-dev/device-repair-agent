"""Port of server/test/migrate.test.ts."""

from __future__ import annotations

import asyncio
import secrets
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any

import asyncpg
import pytest

from app.db.migrate import MigrationError, load_migrations, migrate
from app.db.pool import Database, create_database

EXPECTED_TABLES = [
    "calls",
    "chat_messages",
    "events",
    "field_candidates",
    "file_blobs",
    "files",
    "input_requests",
    "outbox",
    "received_records",
    "records",
    "schema_migrations",
    "sessions",
    "timers",
    "transcript_lines",
    "turn_metrics",
    "usage",
]


class Fresh:
    """An empty schema (no migrations applied) with as many pools on it as a test wants."""

    def __init__(self, base_url: str, name: str) -> None:
        self.base_url = base_url
        self.name = name
        self.opened: list[Database] = []

    async def open(self, max_size: int = 5) -> Database:
        db = await create_database(self.base_url, schema=self.name, max_size=max_size)
        self.opened.append(db)
        return db


@pytest.fixture
async def fresh(test_database_url: str) -> AsyncIterator[Fresh]:
    name = f"mig_{secrets.token_hex(6)}"
    admin = await asyncpg.connect(test_database_url)
    await admin.execute(f"CREATE SCHEMA {name}")
    f = Fresh(test_database_url, name)
    try:
        yield f
    finally:
        await asyncio.gather(*(d.close() for d in f.opened))
        await admin.execute(f"DROP SCHEMA {name} CASCADE")
        await admin.close()


@pytest.fixture
def migrations_dir(tmp_path: Path) -> Callable[[dict[str, str]], Path]:
    def make(files: dict[str, str]) -> Path:
        directory = tmp_path / f"migrations-{secrets.token_hex(3)}"
        directory.mkdir()
        for name, sql in files.items():
            (directory / name).write_text(sql)
        return directory

    return make


async def tables(db: Database) -> list[str]:
    rows = await db.pool.fetch(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY 1"
    )
    return [r["table_name"] for r in rows]


class TestRealMigrations:
    async def test_creates_the_whole_schema_on_an_empty_database_then_applies_nothing_on_the_second_run(
        self, fresh: Fresh
    ) -> None:
        db = await fresh.open()
        assert await tables(db) == []

        assert (await migrate(db.pool)).applied == ["001_init"]
        assert await tables(db) == EXPECTED_TABLES
        rows = await db.pool.fetch("SELECT version, name FROM schema_migrations")
        assert [(r["version"], r["name"]) for r in rows] == [(1, "001_init")]

        assert (await migrate(db.pool)).applied == []
        assert await db.pool.fetchval("SELECT count(*)::int FROM schema_migrations") == 1

    async def test_applies_each_migration_exactly_once_when_several_processes_boot_at_the_same_time(
        self, fresh: Fresh
    ) -> None:
        pools = [await fresh.open() for _ in range(6)]
        results = await asyncio.gather(*(migrate(db.pool) for db in pools))
        assert [name for r in results for name in r.applied] == ["001_init"]
        assert await tables(await fresh.open()) == EXPECTED_TABLES


class TestRunnerBehaviour:
    async def test_serialises_slow_non_idempotent_migrations_across_concurrent_runners(
        self, fresh: Fresh, migrations_dir: Any
    ) -> None:
        # Without the lock, overlapping runners would both run CREATE TABLE and one would fail.
        directory = migrations_dir(
            {
                "001_slow.sql": "SELECT pg_sleep(0.3); CREATE TABLE once_only (id int);",
                "002_next.sql": "CREATE TABLE also_once (id int); INSERT INTO also_once VALUES (1);",
            }
        )
        pools = [await fresh.open() for _ in range(5)]
        results = await asyncio.gather(*(migrate(db.pool, directory) for db in pools))
        assert sorted(name for r in results for name in r.applied) == ["001_slow", "002_next"]
        assert await (await fresh.open()).pool.fetchval("SELECT count(*)::int FROM also_once") == 1

    async def test_rolls_a_failing_migration_back_completely_and_records_nothing_for_it(
        self, fresh: Fresh, migrations_dir: Any
    ) -> None:
        db = await fresh.open()
        directory = migrations_dir(
            {
                "001_ok.sql": "CREATE TABLE ok_table (id int);",
                "002_broken.sql": "CREATE TABLE half_done (id int); SELECT 1 / 0;",
            }
        )
        with pytest.raises(asyncpg.DivisionByZeroError) as info:
            await migrate(db.pool, directory)
        assert info.value.sqlstate == "22012"
        assert await tables(db) == ["ok_table", "schema_migrations"]
        assert [r["name"] for r in await db.pool.fetch("SELECT name FROM schema_migrations")] == ["001_ok"]

    async def test_refuses_to_boot_when_an_applied_migration_was_edited(
        self, fresh: Fresh, migrations_dir: Any
    ) -> None:
        db = await fresh.open()
        directory = migrations_dir({"001_a.sql": "CREATE TABLE a (id int);"})
        await migrate(db.pool, directory)
        (directory / "001_a.sql").write_text("CREATE TABLE a (id bigint);")
        with pytest.raises(MigrationError, match="was changed after it was applied"):
            await migrate(db.pool, directory)

    def test_rejects_badly_named_or_non_contiguous_migration_files(self, migrations_dir: Any) -> None:
        with pytest.raises(MigrationError):
            load_migrations(migrations_dir({"1_init.sql": ""}))
        with pytest.raises(MigrationError, match="contiguous"):
            load_migrations(migrations_dir({"001_a.sql": "", "003_c.sql": ""}))
        assert [m.name for m in load_migrations()] == ["001_init"]

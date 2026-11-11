"""Versioned SQL migrations, applied at boot.

Each migration runs in its own transaction, guarded by a transaction-scoped advisory lock. Session-level locks do not
work through Neon's transaction-mode pooler; `pg_advisory_xact_lock` does. Two instances booting at once therefore
apply each migration exactly once: the second waits, then sees it recorded and skips it.
"""

from __future__ import annotations

import asyncio
import hashlib
import re
from dataclasses import dataclass
from pathlib import Path

import asyncpg
import structlog

from .pool import is_transient_db_error

MIGRATIONS_DIR = Path(__file__).parent / "migrations"

#: Generous for DDL and for waiting on another instance's lock; the pool's 10 s limit is for app queries.
MIGRATION_STATEMENT_TIMEOUT = "60s"
BOOT_RETRY_DELAY_S = 1.0

_FILE_NAME = re.compile(r"^(\d{3})_([a-z0-9_]+)\.sql$")


class MigrationError(Exception):
    pass


@dataclass(frozen=True)
class Migration:
    version: int
    name: str
    sql: str
    checksum: str


@dataclass(frozen=True)
class MigrateResult:
    #: Names of the migrations this call applied (empty when the schema was already current).
    applied: list[str]


def load_migrations(directory: Path = MIGRATIONS_DIR) -> list[Migration]:
    """Reads `NNN_name.sql` files in version order. Versions must be unique and contiguous from 001."""
    migrations: list[Migration] = []
    for path in sorted(p for p in directory.iterdir() if p.suffix == ".sql"):
        match = _FILE_NAME.match(path.name)
        if not match:
            raise MigrationError(f"Bad migration file name: {path.name} (expected NNN_name.sql)")
        sql = path.read_text(encoding="utf8")
        migrations.append(
            Migration(int(match[1]), f"{match[1]}_{match[2]}", sql, hashlib.sha256(sql.encode()).hexdigest())
        )
    for index, migration in enumerate(migrations):
        if migration.version != index + 1:
            raise MigrationError(
                f"Migration versions must be contiguous from 001; found {migration.name} at position {index + 1}"
            )
    return migrations


async def _apply_one(pool: asyncpg.Pool, migration: Migration) -> bool:
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute(f"SET LOCAL statement_timeout = '{MIGRATION_STATEMENT_TIMEOUT}'")
        # Keyed by schema, so separate schemas (one per test) migrate independently.
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtext('device-repair-agent:migrations:' || current_schema()))"
        )
        await conn.execute(
            """CREATE TABLE IF NOT EXISTS schema_migrations (
                 version integer PRIMARY KEY,
                 name text NOT NULL,
                 checksum text NOT NULL,
                 applied_at timestamptz NOT NULL DEFAULT now()
               )"""
        )
        row = await conn.fetchrow("SELECT name, checksum FROM schema_migrations WHERE version = $1", migration.version)
        if row:
            if row["checksum"] != migration.checksum:
                raise MigrationError(
                    f"Migration {migration.name} was changed after it was applied; add a new migration instead"
                )
            return False
        await conn.execute(migration.sql)
        await conn.execute(
            "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
            migration.version,
            migration.name,
            migration.checksum,
        )
        return True


async def migrate(pool: asyncpg.Pool, directory: Path = MIGRATIONS_DIR) -> MigrateResult:
    """Applies every pending migration in order. Safe to run concurrently from several processes."""
    applied = [m.name for m in load_migrations(directory) if await _apply_one(pool, m)]
    return MigrateResult(applied)


async def migrate_at_boot(
    pool: asyncpg.Pool, log: structlog.typing.FilteringBoundLogger, directory: Path = MIGRATIONS_DIR
) -> MigrateResult:
    """Boot entry point: one retry after a connection-level failure (Neon cold start), never after a SQL error."""
    try:
        return await migrate(pool, directory)
    except Exception as err:
        if not is_transient_db_error(err):
            raise
        log.warning("database not reachable; retrying once", code=getattr(err, "sqlstate", None), message=str(err))
        await asyncio.sleep(BOOT_RETRY_DELAY_S)
        return await migrate(pool, directory)

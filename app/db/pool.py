"""Postgres connection pool: Neon's pooled endpoint in production, a throwaway local Postgres in tests.

asyncpg is used so the SQL keeps its `$1` placeholders. Neon's pooler runs in transaction mode, which does not
support server-side prepared statements, so the statement cache is off (`statement_cache_size=0`).
"""

from __future__ import annotations

import json
import ssl as ssl_lib
from collections.abc import Callable
from dataclasses import dataclass, field
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import asyncpg

POOL_MAX = 5
TIMEOUT_MS = 10_000

LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
_TRANSIENT_SQLSTATES = frozenset({"08000", "08001", "08003", "08006", "57P01", "57P02", "57P03"})


@dataclass
class PoolStats:
    #: Times a connection was checked out of the pool; every query goes through one.
    acquired: int = 0


@dataclass
class Database:
    pool: asyncpg.Pool
    stats: PoolStats = field(default_factory=PoolStats)

    async def close(self) -> None:
        await self.pool.close()


def connection_settings(connection_string: str) -> tuple[str, ssl_lib.SSLContext | bool]:
    """The DSN without `sslmode`, and the TLS setting.

    Anything except `disable` verifies the certificate and host name. A local host without an sslmode connects in
    plain text (test databases).
    """
    parts = urlsplit(connection_string)
    query = parse_qsl(parts.query, keep_blank_values=True)
    sslmode = next((value for key, value in query if key == "sslmode"), None)
    rest = [(key, value) for key, value in query if key != "sslmode"]
    plain = sslmode == "disable" or (sslmode is None and (parts.hostname or "") in LOCAL_HOSTS)
    dsn = urlunsplit(parts._replace(query=urlencode(rest)))
    return dsn, False if plain else ssl_lib.create_default_context()


async def _init_connection(conn: asyncpg.Connection) -> None:
    """json/jsonb as Python objects and uuid as str, so rows look like the JSON the app stores."""
    await conn.set_type_codec("jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")
    await conn.set_type_codec("json", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")
    await conn.set_type_codec("uuid", encoder=str, decoder=str, schema="pg_catalog", format="text")


async def create_database(
    connection_string: str,
    *,
    schema: str | None = None,
    max_size: int = POOL_MAX,
    on_error: Callable[[BaseException], None] | None = None,
) -> Database:
    """Opens the pool. `schema` sets the search_path (one schema per test)."""
    dsn, ssl = connection_settings(connection_string)
    stats = PoolStats()
    server_settings: dict[str, str] = {"application_name": "voice-chat-agent", "statement_timeout": str(TIMEOUT_MS)}
    if schema:
        server_settings["search_path"] = schema

    async def count_checkout(_conn: asyncpg.Connection) -> None:
        stats.acquired += 1  # the pool metric tests assert on; runs on every acquire

    pool = await asyncpg.create_pool(
        dsn,
        ssl=ssl,
        min_size=0,
        max_size=max_size,
        command_timeout=TIMEOUT_MS / 1000,
        timeout=TIMEOUT_MS / 1000,
        max_inactive_connection_lifetime=30,
        statement_cache_size=0,
        server_settings=server_settings,
        init=_init_connection,
        setup=count_checkout,
    )
    assert pool is not None
    return Database(pool=pool, stats=stats)


def is_transient_db_error(err: BaseException) -> bool:
    """Connection-level failures worth one retry (Neon cold start, a dropped connection); never SQL errors."""
    if isinstance(err, ConnectionError | TimeoutError | OSError | asyncpg.PostgresConnectionError):
        return True
    return getattr(err, "sqlstate", None) in _TRANSIENT_SQLSTATES

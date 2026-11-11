"""Per-test schemas in the throwaway test database. Each schema is dropped after use."""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import asyncpg

from app.db.migrate import migrate
from app.db.pool import Database, create_database


def schema_url(base: str, schema: str) -> str:
    """A connection string whose sessions use `schema` (search_path), for a pool or a spawned server."""
    parts = urlsplit(base)
    query = [*parse_qsl(parts.query), ("options", f"-c search_path={schema}")]
    return urlunsplit(parts._replace(query=urlencode(query)))


@dataclass
class TestSchema:
    __test__ = False  # not a pytest class

    name: str
    base_url: str
    url: str
    db: Database

    async def open(self, *, max_size: int = 5) -> Database:
        """Another pool on this schema; closed by drop() only if you close it yourself."""
        return await create_database(self.base_url, schema=self.name, max_size=max_size)

    async def drop(self) -> None:
        await self.db.close()
        admin = await asyncpg.connect(self.base_url)
        try:
            await admin.execute(f"DROP SCHEMA {self.name} CASCADE")
        finally:
            await admin.close()


async def create_migrated_schema(base_url: str, label: str = "t", *, max_size: int = 5) -> TestSchema:
    name = f"{label}_{secrets.token_hex(6)}"
    assert name.replace("_", "").isalnum() and name[0].isalpha(), f"unsafe schema name: {name}"
    admin = await asyncpg.connect(base_url)
    try:
        await admin.execute(f"CREATE SCHEMA {name}")
    finally:
        await admin.close()
    db = await create_database(base_url, schema=name, max_size=max_size)
    await migrate(db.pool)
    return TestSchema(name=name, base_url=base_url, url=schema_url(base_url, name), db=db)

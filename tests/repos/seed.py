"""Small builders for repository tests (port of server/test/helpers/seed.ts)."""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable, Callable

import asyncpg

from app.db.repos.events import append_event
from app.db.repos.sessions import insert_session, lock_session
from app.db.tx import transaction

HASH = "0" * 64


async def seed_session(pool: asyncpg.Pool) -> str:
    id = str(uuid.uuid4())
    if await insert_session(pool, id=id) is None:
        raise RuntimeError("session already exists")
    return id


async def seed_event(pool: asyncpg.Pool, session_id: str, type: str = "test.event") -> int:
    """Appends one event under the session lock and returns its seq."""
    async with transaction(pool) as tx:
        await lock_session(tx, session_id)
        return (await append_event(tx, session_id=session_id, type=type, channel="system")).seq


def barrier(count: int) -> Callable[[], Awaitable[None]]:
    """Resolves for every caller once `count` callers have arrived (holds concurrent transactions open together)."""
    arrived = 0
    opened = asyncio.Event()

    async def wait() -> None:
        nonlocal arrived
        arrived += 1
        if arrived == count:
            opened.set()
        await opened.wait()

    return wait

"""Lazy session creation (D08, protocol.md section 2).

The browser picks the session id (a UUIDv4); the first valid /chat connect, /call connect or upload for an unknown id
creates the session and its ``session.created`` event. Loading an existing session is never rate-limited and never
counts as user activity.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from app.db.repos.events import append_event
from app.db.repos.sessions import Session, get_session, insert_session, lock_session
from app.db.repos.timers import Timer, upsert_timer
from app.db.tx import transaction

from .creation_limit import CreationLimiter

#: What caused the session to be created; recorded in the ``session.created`` event.
SessionOrigin = Literal["chat", "call", "upload", "testApi"]

#: PD10: the page was opened; if no call starts within this long, the chat takes over (the ``noCallStart`` timer).
DEFAULT_NO_CALL_START_MS = 2 * 60 * 1000


@dataclass(frozen=True, slots=True)
class NewSessionSettings:
    """What a newly created session starts with (P4-T04): its ``noCallStart`` deadline, reported to the sweeper."""

    no_call_start_ms: float
    on_timer_scheduled: Callable[[datetime], None] | None = None


@dataclass(frozen=True, slots=True)
class CreationLimit:
    """Limits creation per client; omit for trusted callers (the token-gated test API)."""

    limiter: CreationLimiter
    key: str


@dataclass(frozen=True, slots=True)
class EnsureSessionResult:
    """``ok`` True: ``session`` and ``created``. ``ok`` False: ``reason`` is ``"rate_limited"``."""

    ok: bool
    session: Session | None = None
    created: bool = False
    reason: str | None = None


#: Creations in progress in this process, by session id, so concurrent connects for one new id share one attempt.
_creating: dict[str, asyncio.Future[EnsureSessionResult]] = {}


async def ensure_session(
    pool: Any,
    id: str,
    *,
    via: SessionOrigin,
    limit: CreationLimit | None = None,
    new_session: NewSessionSettings | None = None,
) -> EnsureSessionResult:
    """Loads the session, or creates it if it doesn't exist. ``id`` must already be a canonical UUIDv4 (parse_session_id).

    Concurrent calls for one new id create it exactly once and use at most one rate-limit slot: in this process they
    join a single attempt; across processes the insert is ``ON CONFLICT DO NOTHING`` and the loser reads the winner's row.
    """
    existing = await get_session(pool, id)
    if existing is not None:
        return EnsureSessionResult(ok=True, session=existing, created=False)

    in_progress = _creating.get(id)
    if in_progress is not None:
        try:
            joined: EnsureSessionResult | None = await asyncio.shield(in_progress)
        except Exception:
            joined = None
        if joined is not None and joined.ok:
            return EnsureSessionResult(ok=True, session=joined.session, created=False)
        # The shared attempt failed, or was refused on another client's budget: try once on our own.
        return await _create(pool, id, via, limit, new_session)
    attempt = asyncio.ensure_future(_create(pool, id, via, limit, new_session))
    _creating[id] = attempt
    try:
        return await attempt
    finally:
        if _creating.get(id) is attempt:
            del _creating[id]


async def _create(
    pool: Any, id: str, via: SessionOrigin, limit: CreationLimit | None, new_session: NewSessionSettings | None
) -> EnsureSessionResult:
    if limit is not None and not limit.limiter.try_acquire(limit.key):
        # A concurrent connect for the same id (e.g. chat and call opening together) may have just used the last slot
        # to create this very session; joining it creates nothing, so it isn't refused.
        created = await get_session(pool, id)
        if created is not None:
            return EnsureSessionResult(ok=True, session=created, created=False)
        return EnsureSessionResult(ok=False, reason="rate_limited")
    no_call_start_at = (
        datetime.now(UTC) + timedelta(milliseconds=new_session.no_call_start_ms) if new_session is not None else None
    )
    try:
        async with transaction(pool) as tx:
            inserted = await insert_session(tx, id=id)
            if inserted is None:
                # Another connection created it after our read. Its transaction has committed, so the row is visible.
                session = await get_session(tx, id)
                if session is None:
                    raise RuntimeError("session vanished after a conflicting insert")
                created_here = False
            else:
                # Our own uncommitted row: the lock is free, and taking it keeps append_event's precondition explicit.
                session = await lock_session(tx, id)
                if session is None:
                    raise RuntimeError("inserted session not found")
                await append_event(tx, session_id=id, type="session.created", channel="system", payload={"via": via})
                if no_call_start_at is not None:
                    await upsert_timer(tx, Timer(session_id=id, kind="noCallStart", due_at=no_call_start_at))
                created_here = True
    except BaseException:
        if limit is not None:
            limit.limiter.release(limit.key)
        raise
    if not created_here:
        if limit is not None:
            limit.limiter.release(limit.key)
    elif no_call_start_at is not None and new_session is not None and new_session.on_timer_scheduled is not None:
        new_session.on_timer_scheduled(no_call_start_at)
    return EnsureSessionResult(ok=True, session=session, created=created_here)

"""The concrete call-engine adapter over the session services (P5): see ``app.voice.call_session.CallSessionPort``.

The adapter itself lives with the call engine (``app.voice.call_session``: commands through the processor, a fresh
read of the state for each LLM call, the hub for chat events, usage ledger and turn metrics); this wrapper builds it
from ``SessionServices``.
"""

from __future__ import annotations

from typing import Any

from app.voice.call_session import CallSessionPort
from app.voice.call_session import create_call_session_port as _create

from .services import SessionServices


def create_call_session_port(
    *, pool: Any, services: SessionServices, session_id: str, log: Any | None = None
) -> CallSessionPort:
    return _create(pool=pool, processor=services.processor, hub=services.hub, session_id=session_id, log=log)

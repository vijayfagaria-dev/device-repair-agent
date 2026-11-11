"""The call engine's view of its session (P5).

Commands through the processor, a fresh read of the state for each LLM call, the hub for chat events, and the usage
ledger and turn metrics. The production port is ``create_call_session_port``; tests fake it. Ledger and metric writes
never fail the call: an error is logged.

Commands and replies are plain dicts (the session's ``Command`` objects and handler replies), with the keys the session
package defines (see ``CallEngine`` for the ones this engine sends).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

import structlog

from app.db.repos.field_candidates import list_field_candidates
from app.db.repos.input_requests import StoredInputRequest, list_input_requests
from app.db.repos.sessions import Session, get_session
from app.db.repos.turn_metrics import upsert_turn_metric
from app.domain.conflicts import ResolvedField
from app.metrics.usage import record_llm_usage, record_usage
from app.voice.types import LlmRoute, LlmUsage

#: Why a call ended (``EndCall.reason``).
CallEndReason = str


@dataclass(slots=True)
class CallContext:
    session: Session
    fields: dict[str, ResolvedField]
    requests: list[StoredInputRequest]
    #: The last thing the agent said on an earlier call of this session (a returning call's summary, P5-T12).
    last_agent_line_before: str | None


class CallSessionPort(Protocol):
    @property
    def session_id(self) -> str: ...

    async def dispatch(self, command: dict[str, Any]) -> Any:
        """Runs a command through the processor and returns its reply (None when the command has none)."""
        ...

    async def context(self, call_id: str) -> CallContext: ...

    def subscribe(self, listener: Callable[[Any], None]) -> Callable[[], None]:
        """Session updates (``update.events``: each with ``type``, ``channel``, ``payload``); returns the unsubscribe."""
        ...

    async def reconcile(self) -> None:
        """Runs the planner now (the 60 s safety net needs no other command to happen, P4 review #9)."""
        ...

    async def record_llm_usage(self, route: LlmRoute, usage: LlmUsage) -> None: ...

    async def record_llm_request(self, route: LlmRoute) -> None:
        """A model call that ended before the provider reported usage (aborted): counted as a request (quota guard)."""
        ...

    async def record_stt_seconds(self, seconds: float) -> None: ...

    async def record_tts_characters(self, characters: int) -> None: ...

    async def record_turn_metric(self, metric: dict[str, Any]) -> None: ...


class _ProductionPort:
    def __init__(self, *, pool: Any, processor: Any, hub: Any, session_id: str, log: Any) -> None:
        self._pool = pool
        self._processor = processor
        self._hub = hub
        self._session_id = session_id
        self._log = log

    @property
    def session_id(self) -> str:
        return self._session_id

    async def _quietly(self, what: str, write: Callable[[], Any]) -> None:
        try:
            await write()
        except Exception as err:
            self._log.error(f"{what} failed", code=getattr(err, "sqlstate", None), message=str(err))

    async def dispatch(self, command: dict[str, Any]) -> Any:
        return (await self._processor.dispatch(self._session_id, command)).reply

    async def context(self, call_id: str) -> CallContext:
        from app.session.snapshot import resolve_fields  # lazy: the session package imports the agent package

        session = await get_session(self._pool, self._session_id)
        candidates = await list_field_candidates(self._pool, self._session_id)
        requests = await list_input_requests(self._pool, self._session_id)
        last = await self._pool.fetchval(
            "SELECT text FROM transcript_lines WHERE session_id = $1 AND role = 'agent' AND call_id <> $2 ORDER BY event_seq DESC LIMIT 1",
            self._session_id,
            call_id,
        )
        if session is None:
            raise RuntimeError("session not found")
        return CallContext(
            session=session, fields=resolve_fields(candidates), requests=requests, last_agent_line_before=last
        )

    def subscribe(self, listener: Callable[[Any], None]) -> Callable[[], None]:
        return self._hub.subscribe(self._session_id, listener)

    async def reconcile(self) -> None:
        await self._processor.react(self._session_id)

    async def record_llm_usage(self, route: LlmRoute, usage: LlmUsage) -> None:
        await self._quietly(
            "LLM usage",
            lambda: record_llm_usage(
                self._pool,
                session_id=self._session_id,
                provider=route.provider,
                model=route.model,
                prompt_tokens=usage.prompt_tokens,
                completion_tokens=usage.completion_tokens,
                cached_tokens=min(usage.cached_tokens, usage.prompt_tokens),
            ),
        )

    async def record_llm_request(self, route: LlmRoute) -> None:
        await self._quietly(
            "LLM request",
            lambda: record_usage(
                self._pool,
                session_id=self._session_id,
                provider=route.provider,
                kind=f"{route.model}:requests",
                units=1,
            ),
        )

    async def record_stt_seconds(self, seconds: float) -> None:
        if seconds <= 0:
            return
        await self._quietly(
            "STT usage",
            lambda: record_usage(
                self._pool, session_id=self._session_id, provider="deepgram", kind="nova-3:audio", units=seconds
            ),
        )

    async def record_tts_characters(self, characters: int) -> None:
        if characters <= 0:
            return
        await self._quietly(
            "TTS usage",
            lambda: record_usage(
                self._pool, session_id=self._session_id, provider="deepgram", kind="aura-2:characters", units=characters
            ),
        )

    async def record_turn_metric(self, metric: dict[str, Any]) -> None:
        await self._quietly(
            "turn metric", lambda: upsert_turn_metric(self._pool, session_id=self._session_id, **metric)
        )


def create_call_session_port(
    *, pool: Any, processor: Any, hub: Any, session_id: str, log: Any | None = None
) -> CallSessionPort:
    """The production port. ``processor`` has ``dispatch(session_id, command)`` and ``react(session_id)``; ``hub`` has
    ``subscribe(session_id, listener)``."""
    return _ProductionPort(
        pool=pool, processor=processor, hub=hub, session_id=session_id, log=log or structlog.get_logger()
    )

"""WS /call (P5-T02; protocol.md sections 3.1-3.2 and 6).

Handshake as /chat (Origin, session id, lazy creation), then: a closed session -> 4410; the quota guard -> 4429
`quota`; a call already running (or being set up) for this session -> 4409; the per-instance call cap -> 4429 `capacity`;
StartCall (one active call per session, D11) -> 4409 for a second one. Then a CallEngine runs the call. Mic frames must be
exactly 640 bytes (others are dropped and counted), messages over 4 KB close with 1009, and a 15 s pong timeout catches
half-open connections (keep_alive.py). Every way the socket closes ends the call exactly once (EndCall): the user
hanging up, the tab closing or the network dropping (by close code), server shutdown (1012), or the engine itself
(agent ended, silence, max duration, provider error).
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, NamedTuple

from app.limits.quota_guard import QuotaGuard, is_provider_refusal
from app.protocol.constants import MIC_FRAME_BYTES
from app.protocol.session import CloseCode
from app.protocol.types import to_wire
from app.session.commands import CommandProcessor
from app.session.handlers.call import EndCall, StartCall
from app.session.hub import SessionHub
from app.voice.barge_in import BargeInSettings
from app.voice.call_engine import CallEngine, CallTimings
from app.voice.call_session import create_call_session_port
from app.voice.clock import Clock, real_clock
from app.voice.types import LlmClient, SttProvider, TtsProvider

from .closing import close_with_notice
from .handshake import SocketDeps, accept_session_socket
from .keep_alive import CALL_KEEPALIVE, KeepAliveOptions
from .socket import ManagedSocket

#: protocol.md section 7: /call messages are at most 4 KB (the shared server limit is /chat's).
MAX_CALL_MESSAGE_BYTES = 4 * 1024
#: Mic frames are 20 ms each, so a real mic sends 50 a second; a 2 s burst allows for network jitter (P5 review #12).
MAX_FRAMES_PER_SECOND = 50
MAX_FRAME_BURST = 100

__all__ = [
    "CALL_KEEPALIVE",
    "MAX_CALL_MESSAGE_BYTES",
    "MAX_FRAMES_PER_SECOND",
    "MAX_FRAME_BURST",
    "ActiveCalls",
    "CallSocketDeps",
    "CallState",
    "Providers",
    "VoiceDeps",
    "call_socket",
    "end_reason_for",
    "settle_calls",
]


class Providers(NamedTuple):
    stt: SttProvider
    tts: TtsProvider
    llm: LlmClient


@dataclass(slots=True)
class VoiceDeps:
    #: The providers for one call (real Deepgram/Groq in production, fakes in tests).
    providers: Callable[[], Providers]
    #: MAX_CONCURRENT_CALLS: calls this instance runs at once (free-tier rate limits, P0-T03: starts at 1).
    max_concurrent_calls: int
    clock: Clock | None = None
    timings: CallTimings | None = None
    barge_in: BargeInSettings | None = None
    #: The /call keepalive (default CALL_KEEPALIVE; tests shorten it: see ws.keep_alive.uvicorn_ws_options).
    keep_alive: KeepAliveOptions | None = None
    #: The free-tier quota guard (P10-T03): a new call is refused with 4429 `quota` while it says no.
    quota: QuotaGuard | None = None


@dataclass(slots=True)
class CallSocketDeps:
    socket: SocketDeps
    hub: SessionHub
    processor: CommandProcessor
    #: None: voice isn't configured, and /call refuses with 1011.
    voice: VoiceDeps | None = None


def end_reason_for(code: int) -> str:
    """Why the call ended, from how the socket closed (when the engine didn't end it itself)."""
    if code == CloseCode.SERVER_RESTARTING:
        return "server_restart"
    # 1000 normal, 1001 going away (tab closed), 1005 no status: the user ended it.
    if code in (1000, 1001, 1005):
        return "hangup"
    return "network"  # 1006 (dropped, or terminated after missed pongs) and anything else


class ActiveCalls:
    """The calls running on this instance (for the cap, shutdown and tests)."""

    def __init__(self) -> None:
        self.engines: set[CallEngine] = set()

    @property
    def size(self) -> int:
        return len(self.engines)

    async def settled(self) -> None:
        """Resolves when every call has ended."""
        await asyncio.gather(*(engine.when_ended for engine in list(self.engines)), return_exceptions=True)


async def settle_calls(active: ActiveCalls, timeout_ms: float = 3_000) -> bool:
    """Waits (at most `timeout_ms`) for every call to finish ending: EndCall must commit before the pool closes, or the
    session would be left with an active call (P5 review #4). Shutdown's 1012 close has already started each end."""
    if active.size == 0:
        return True
    try:
        await asyncio.wait_for(active.settled(), timeout_ms / 1000)
    except TimeoutError:
        return False
    return True


@dataclass(slots=True)
class CallState:
    """What the /call route shares between connections."""

    active: ActiveCalls = field(default_factory=ActiveCalls)
    #: Calls being set up count against the cap too (two connects at once can't both slip under it).
    starting: int = 0
    #: Sessions with a call running or being set up. A second connect for the same session is refused as "already
    #: active" before the capacity check: with a cap of 1 the caller's own live call would otherwise make the refusal
    #: read "voice is busy" (live report, 2026-11-11), which is untrue and hides that the call is still running.
    sessions_in_call: set[str] = field(default_factory=set)


def _new_call_id() -> str:
    return "c" + base64.urlsafe_b64encode(os.urandom(9)).decode("ascii").rstrip("=").replace("_", "-")


def _call_wire(message: Any) -> str:
    wire = message if isinstance(message, dict) else to_wire(message)
    return json.dumps(wire, ensure_ascii=False, separators=(",", ":"))


async def call_socket(socket: ManagedSocket, deps: CallSocketDeps, state: CallState) -> None:
    """The /call endpoint body, on an accepted socket. Returns once the call is set up (or refused); the engine and the
    socket's own message handler carry on from there."""
    accepted = await accept_session_socket(socket, deps.socket, "call", "/call")
    if accepted is None:
        return
    session, log = accepted.session, accepted.log
    voice = deps.voice
    if voice is None:
        log.error("call refused: voice is not configured")
        close_with_notice(socket, CloseCode.SERVER_ERROR, "server error")
        return
    if session.status == "closed":
        close_with_notice(socket, CloseCode.SESSION_CLOSED, "session closed")
        return
    # Before the capacity check, which must stay synchronous with `starting += 1` (the guard's read is async).
    quota = await voice.quota.check() if voice.quota is not None else None
    if quota is not None and not quota["ok"]:
        log.warning("call refused: quota", reason=quota.get("reason"))
        close_with_notice(socket, CloseCode.RATE_LIMITED, "quota")
        return
    if not socket.is_open:
        return
    if session.id in state.sessions_in_call:
        log.warning("call refused: this session already has a call")
        close_with_notice(socket, CloseCode.CALL_ALREADY_ACTIVE, "call already active")
        return
    if state.active.size + state.starting >= voice.max_concurrent_calls:
        log.warning("call refused: capacity", active=state.active.size, max=voice.max_concurrent_calls)
        close_with_notice(socket, CloseCode.RATE_LIMITED, "capacity")
        return
    state.starting += 1
    state.sessions_in_call.add(session.id)
    started = False
    call_id = _new_call_id()
    engine: CallEngine | None = None
    # The socket can close at any point, also while the providers are still opening: keep its close code, so the call
    # ends with the right reason whenever the engine is ready (a hang-up in the first second isn't "network").
    close_code: int | None = None
    on_closed: Callable[[int], None] | None = None

    def socket_closed(code: int) -> None:
        nonlocal close_code
        close_code = code
        if on_closed is not None:
            on_closed(code)

    socket.on_close(socket_closed)
    try:
        result = await deps.processor.dispatch(session.id, StartCall(call_id=call_id))
        reply = result.reply
        if reply and reply.get("status") == "refused":
            reason = reply.get("reason")
            if reason == "closed":
                code, why = CloseCode.SESSION_CLOSED, "session closed"
            elif reason == "resumeRequired":
                code, why = CloseCode.RESUME_REQUIRED, "resume required"
            else:
                code, why = CloseCode.CALL_ALREADY_ACTIVE, "call already active"
            close_with_notice(socket, code, why)
            return
        if close_code is not None:
            # Gone during StartCall: the call that just started ends at once, for the reason it closed.
            await deps.processor.dispatch(session.id, EndCall(call_id=call_id, reason=end_reason_for(close_code)))
            return
        call_log = log.bind(call_id=call_id)
        providers = voice.providers()

        def send(message: Any) -> None:
            if socket.is_open:
                socket.send_text(_call_wire(message))

        def close(code: int, reason: str) -> None:
            if socket.is_open:
                close_with_notice(socket, code, reason)

        engine = await CallEngine.start(
            call_id=call_id,
            port=create_call_session_port(
                pool=deps.socket.pool,
                processor=deps.processor,
                hub=deps.hub,
                session_id=session.id,
                log=call_log,
            ),
            stt=providers[0],
            tts=providers[1],
            llm=providers[2],
            clock=voice.clock or real_clock,
            log=call_log,
            returning=bool(reply and reply.get("status") == "started" and reply.get("returning")),
            timings=voice.timings,
            barge_in=voice.barge_in,
            send=send,
            close=close,
        )
        started = True
    except Exception as err:
        # The engine closes the socket itself when a provider fails; anything else (StartCall's database) is 1011.
        log.error("call failed to start", code=getattr(err, "sqlstate", None), message=str(err))
        # Deepgram refusing the key or the credit (401/402/403) won't fix itself: stop trying for a while.
        if is_provider_refusal(err) and voice.quota is not None:
            voice.quota.provider_refused("deepgram")
        if socket.is_open:
            close_with_notice(socket, CloseCode.SERVER_ERROR, "server error")
        return
    finally:
        state.starting -= 1
        if not started:
            state.sessions_in_call.discard(session.id)

    assert engine is not None
    running = engine
    state.active.engines.add(running)

    def call_ended(_future: Any) -> None:
        state.active.engines.discard(running)
        state.sessions_in_call.discard(session.id)

    running.when_ended.add_done_callback(call_ended)

    def stop(code: int) -> None:
        running.stop(end_reason_for(code)).add_done_callback(lambda _f: state.active.engines.discard(running))

    if close_code is not None:
        stop(close_code)
        return
    on_closed = stop

    dropped = 0
    # Faster than real time isn't a mic: frames beyond the rate are dropped, not sent to (and billed by) the STT.
    tokens: float = MAX_FRAME_BURST
    refilled_at = time.monotonic()

    def on_message(data: str | bytes, is_binary: bool) -> None:
        nonlocal dropped, tokens, refilled_at
        size = len(data) if isinstance(data, bytes) else len(data.encode("utf-8"))
        if size > MAX_CALL_MESSAGE_BYTES:
            close_with_notice(socket, CloseCode.MESSAGE_TOO_BIG, "message too big")
            return
        # Text frames are reserved (P13); a binary frame of any other length isn't mic audio.
        if not is_binary or size != MIC_FRAME_BYTES:
            dropped += 1
            if dropped == 1 or dropped % 500 == 0:
                log.debug("call frames dropped", dropped=dropped)
            return
        now = time.monotonic()
        tokens = min(MAX_FRAME_BURST, tokens + (now - refilled_at) * MAX_FRAMES_PER_SECOND)
        refilled_at = now
        if tokens < 1:
            dropped += 1
            if dropped % 500 == 1:
                log.warning("call frames dropped: faster than real time", dropped=dropped)
            return
        tokens -= 1
        running.push_audio(data if isinstance(data, bytes) else data.encode("utf-8"))

    socket.on_message(on_message)

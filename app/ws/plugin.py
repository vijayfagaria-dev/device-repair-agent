"""WebSocket support: the /chat and /call routes on the FastAPI app, the registry of open sockets and the shutdown close.

Routes: /chat (ws/chat.py) and /call (ws/call.py). Every socket is accepted first and refusals are close frames (the
browser sees onopen, then the reason), so the Origin check and the session id check live in the handshake, not in the
route.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from fastapi import FastAPI, WebSocket

from app.api.client_ip import make_client_ip
from app.limits.quota_guard import QuotaGuard
from app.protocol.session import CloseCode, CloseReason
from app.session.creation_limit import CreationLimiter
from app.session.ensure_session import NewSessionSettings
from app.session.services import SessionServices

from .call import ActiveCalls, CallSocketDeps, CallState, VoiceDeps, call_socket
from .chat import ChatSocketDeps, chat_socket
from .closing import close_with_notice
from .handshake import SocketDeps
from .socket import ManagedSocket

#: The largest inbound message on any socket (protocol.md section 7: /chat 64 KB). /call enforces its smaller 4 KB itself.
MAX_WS_PAYLOAD_BYTES = 64 * 1024

#: How long shutdown waits for clients to answer the 1012 close before dropping them.
SHUTDOWN_CLOSE_GRACE_MS = 2_000

#: How long the endpoint waits for the closing handshake after the server closed a socket.
CLOSE_HANDSHAKE_TIMEOUT_S = 10.0


@dataclass(slots=True)
class WebSocketRuntime:
    """The open sockets and the calls of one app (tests and shutdown use it)."""

    calls: ActiveCalls
    #: The /call route's bookkeeping (sessions with a call running or being set up), for tests.
    call_state: CallState
    sockets: set[ManagedSocket] = field(default_factory=set)

    async def close_sockets(
        self, grace_ms: float = SHUTDOWN_CLOSE_GRACE_MS, code: int = CloseCode.SERVER_RESTARTING
    ) -> int:
        """Shutdown: tells every client the server is restarting (closing message, then 1012), so /chat reconnects and
        replays (protocol.md section 6), and waits up to `grace_ms` for them to go. Returns how many are still open."""
        sockets = list(self.sockets)
        for socket in sockets:
            close_with_notice(socket, code, CloseReason.SERVER_RESTARTING)
        pending = [socket.closed for socket in sockets if not socket.closed.done()]
        if pending:
            await asyncio.wait(pending, timeout=grace_ms / 1000)
        return sum(1 for socket in sockets if not socket.closed.done())


async def _serve(
    websocket: WebSocket, runtime: WebSocketRuntime, log: Any, run: Callable[[ManagedSocket], Awaitable[None]]
) -> None:
    await websocket.accept()
    socket = ManagedSocket(websocket, log)
    runtime.sockets.add(socket)
    socket.start()
    try:
        try:
            await run(socket)
        except Exception as err:
            log.error("websocket handler failed", err=repr(err))
            close_with_notice(socket, CloseCode.SERVER_ERROR, CloseReason.SERVER_ERROR)
        # The socket lives until the peer goes (or, once we closed it, until the closing handshake ends).
        if socket.is_open:
            await socket.wait_closed()
        else:
            await socket.wait_closed(CLOSE_HANDSHAKE_TIMEOUT_S)
    finally:
        runtime.sockets.discard(socket)
        await socket.aclose()


def mount_websockets(
    app: FastAPI,
    *,
    pool: Any,
    public_origin: str,
    session_limiter: CreationLimiter,
    services: SessionServices,
    log: Any,
    new_session: NewSessionSettings | None = None,
    voice: VoiceDeps | None = None,
    quota: QuotaGuard | None = None,
    trust_proxy_hops: int = 0,
) -> WebSocketRuntime:
    """Registers `/chat` and `/call`. Call it before `mount_http_routes` registers the web catch-all (WebSocket scopes
    never meet that catch-all either way, but a plain `GET /chat` must reach it for the JSON 404)."""
    socket_deps = SocketDeps(
        pool=pool,
        public_origin=public_origin,
        session_limiter=session_limiter,
        new_session=new_session,
        client_ip=make_client_ip(trust_proxy_hops),
    )
    state = CallState()
    runtime = WebSocketRuntime(calls=state.active, call_state=state)
    chat_deps = ChatSocketDeps(
        socket=socket_deps,
        hub=services.hub,
        processor=services.processor,
        voice_available=quota.voice_available if quota is not None else None,
    )
    call_deps = CallSocketDeps(socket=socket_deps, hub=services.hub, processor=services.processor, voice=voice)

    async def chat_endpoint(websocket: WebSocket) -> None:
        await _serve(websocket, runtime, log, lambda socket: chat_socket(socket, chat_deps))

    async def call_endpoint(websocket: WebSocket) -> None:
        await _serve(websocket, runtime, log, lambda socket: call_socket(socket, call_deps, state))

    app.add_api_websocket_route("/chat", chat_endpoint)
    app.add_api_websocket_route("/call", call_endpoint)
    return runtime

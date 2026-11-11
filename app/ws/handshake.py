"""The shared opening sequence for /chat and /call (protocol.md section 4 step 1, section 6): check Origin, check the
session id, then load or lazily create the session. Every refusal completes the upgrade and then closes with a code and
reason, because browsers hide refused upgrades behind a bare 1006.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.api.client_ip import ClientIp, peer_ip
from app.db.repos.sessions import Session
from app.protocol.session import CloseCode, CloseReason, parse_session_id
from app.session.creation_limit import CreationLimiter
from app.session.ensure_session import CreationLimit, NewSessionSettings, SessionOrigin, ensure_session

from .closing import close_with_notice
from .socket import ManagedSocket


@dataclass(slots=True)
class SocketDeps:
    pool: Any
    #: The only Origin a browser may connect from (D07).
    public_origin: str
    session_limiter: CreationLimiter
    #: What a session created by this connect starts with (its noCallStart timer, P4-T04).
    new_session: NewSessionSettings | None = None
    client_ip: ClientIp = peer_ip


@dataclass(slots=True)
class AcceptedSocket:
    session: Session
    log: Any


def is_allowed_origin(origin: str | None, public_origin: str) -> bool:
    return origin == public_origin


async def accept_session_socket(
    socket: ManagedSocket, deps: SocketDeps, via: SessionOrigin, path: str
) -> AcceptedSocket | None:
    """Runs the handshake on a freshly accepted socket. Returns the session, or None after closing the socket with the
    reason (or when the client went away during the handshake)."""
    websocket = socket.websocket
    log = socket.log
    if not is_allowed_origin(websocket.headers.get("origin"), deps.public_origin):
        log.warning("websocket refused: origin not allowed", path=path)
        close_with_notice(socket, CloseCode.ORIGIN_NOT_ALLOWED, CloseReason.ORIGIN_NOT_ALLOWED)
        return None

    # Exactly one sessionId, a canonical UUIDv4 (a repeated parameter is not one).
    values = websocket.query_params.getlist("sessionId")
    session_id = parse_session_id(values[0]) if len(values) == 1 else None
    if session_id is None:
        log.info("websocket refused: invalid session id", path=path)
        close_with_notice(socket, CloseCode.INVALID_SESSION_ID, CloseReason.INVALID_SESSION_ID)
        return None

    log = log.bind(session_id=session_id)
    try:
        result = await ensure_session(
            deps.pool,
            session_id,
            via=via,
            limit=CreationLimit(limiter=deps.session_limiter, key=deps.client_ip(websocket)),
            new_session=deps.new_session,
        )
    except Exception as err:
        log.error("websocket refused: session lookup failed", code=getattr(err, "sqlstate", None), message=str(err))
        close_with_notice(socket, CloseCode.SERVER_ERROR, CloseReason.SERVER_ERROR)
        return None
    if not result.ok or result.session is None:
        log.warning("websocket refused: new-session rate limit")
        close_with_notice(socket, CloseCode.RATE_LIMITED, CloseReason.NEW_SESSION_RATE_LIMITED)
        return None
    if result.created:
        log.info("session created", via=via)
    if not socket.is_open:
        return None
    return AcceptedSocket(session=result.session, log=log)

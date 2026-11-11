"""Server-side keepalive (protocol.md section 7): ping every interval and terminate a socket that misses too many pongs.

ASGI has no ping API, so the pings are the ASGI server's own protocol-level ones: uvicorn's ``ws_ping_interval`` and
``ws_ping_timeout`` (the websockets library answers pongs and closes a connection that stays silent). They are
per-server, not per-route, so /chat and /call share one setting: the /call one (ping every 5 s, dead after 15 s), which
is the stricter. It also keeps Render's proxy from dropping idle sockets. ``uvicorn_ws_options`` turns the options into
the keyword arguments of ``uvicorn.Config``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class KeepAliveOptions:
    interval_ms: float
    #: Consecutive unanswered pings before the socket is terminated.
    max_missed: int


DEFAULT_KEEPALIVE = KeepAliveOptions(interval_ms=20_000, max_missed=2)
#: protocol.md section 7: a 15 s pong timeout on /call (pings at 5 s and 10 s unanswered, terminated at 15 s).
CALL_KEEPALIVE = KeepAliveOptions(interval_ms=5_000, max_missed=2)


def uvicorn_ws_options(options: KeepAliveOptions = CALL_KEEPALIVE, *, max_size: int = 64 * 1024) -> dict[str, Any]:
    """`uvicorn.Config` keyword arguments: the ping interval, the pong timeout (the missed pings' worth) and the largest
    inbound message (a bigger one makes uvicorn close with 1009 before the app sees it)."""
    interval = options.interval_ms / 1000
    return {
        "ws": "app.ws.protocol:AppWebSocketProtocol",
        "ws_ping_interval": interval,
        "ws_ping_timeout": interval * options.max_missed,
        "ws_max_size": max_size,
    }

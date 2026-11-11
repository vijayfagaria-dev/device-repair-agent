"""uvicorn's WebSocket protocol with one correction: a connection that ends without a closing handshake is reported to the
app as 1006 (abnormal closure), not 1005.

uvicorn's websockets implementation reports `1005` (no status) whenever the TCP connection ends after the upgrade, also
when the peer vanished or the keepalive ping timed out. /call tells "the user hung up" (a close frame: 1000, 1001, 1005)
from "the network dropped" (1006) by that code (ws.call.end_reason_for), so the two must stay apart. Select it with
`ws="app.ws.protocol:AppWebSocketProtocol"` (`keep_alive.uvicorn_ws_options` does).
"""

from __future__ import annotations

from typing import Any

from uvicorn.protocols.websockets.websockets_sansio_impl import WebSocketsSansIOProtocol


class AppWebSocketProtocol(WebSocketsSansIOProtocol):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        #: The peer sent a close frame, or we sent one: the connection ended through a closing handshake.
        self._orderly = False

    def handle_close(self, event: Any) -> None:
        self._orderly = True
        super().handle_close(event)

    def shutdown(self) -> None:
        self._orderly = True
        super().shutdown()

    def keepalive_timeout(self) -> None:
        # The peer stopped answering pings: an abnormal end, though we send a close frame on the way out.
        self._orderly = False
        self._keepalive_failed = True
        super().keepalive_timeout()

    def connection_lost(self, exc: Exception | None) -> None:
        abnormal = getattr(self, "_keepalive_failed", False) or not (self._orderly or self.close_sent)
        if abnormal and self.handshake_complete:
            # uvicorn reports 1006 for a connection lost before the handshake completed.
            self.handshake_complete = False
        super().connection_lost(exc)

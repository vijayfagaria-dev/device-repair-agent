"""One accepted WebSocket, as the transport code uses it: a reader loop and an ordered writer, both off the endpoint's
own coroutine, so the call engine's synchronous ``send`` callbacks, the hub's listeners and the close handling never
block each other (the TS `ws` socket's event model, over Starlette's receive/send).

- ``send_text`` / ``close`` are synchronous and queue the frame; one writer task sends them in order.
- The reader delivers inbound messages to the handler set with ``on_message`` (those that arrive earlier are held, up to
  ``MAX_PENDING_MESSAGES``), and resolves ``closed`` with the close code when the peer goes away.
- ``is_open`` is the TS ``readyState === OPEN``: true from accept until a close is sent or the peer disconnected.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Callable
from typing import Any

from starlette.websockets import WebSocket, WebSocketState

#: Messages that arrive while the handshake is still talking to the database are held, up to this many.
MAX_PENDING_MESSAGES = 64

#: An inbound message: text (``str``) or binary (``bytes``).
MessageHandler = Callable[[str | bytes, bool], None]


class ManagedSocket:
    def __init__(self, websocket: WebSocket, log: Any) -> None:
        self.websocket = websocket
        self.log = log
        self.closed: asyncio.Future[int] = asyncio.get_running_loop().create_future()
        self._queue: asyncio.Queue[tuple[str, Any, Any] | None] = asyncio.Queue()
        self._open = True
        self._buffered = 0
        self._handler: MessageHandler | None = None
        self._pending: list[tuple[str | bytes, bool]] = []
        self._dropped = 0
        #: The code of the close frame this side sent, if any: it is the socket's close code (as in the TS `close` event).
        self._close_sent: int | None = None
        self._reader: asyncio.Task[None] | None = None
        self._writer: asyncio.Task[None] | None = None
        self._background: set[asyncio.Task[Any]] = set()

    # -- lifecycle ----------------------------------------------------------------------------------------------------

    def start(self) -> None:
        self._reader = asyncio.ensure_future(self._read())
        self._writer = asyncio.ensure_future(self._write())

    @property
    def is_open(self) -> bool:
        return self._open and not self.closed.done()

    @property
    def buffered_amount(self) -> int:
        """Bytes queued for sending and not yet written (the TS ``bufferedAmount``)."""
        return self._buffered

    @property
    def close_code(self) -> int | None:
        return self.closed.result() if self.closed.done() else None

    def on_close(self, callback: Callable[[int], None]) -> None:
        """Runs `callback(code)` once the socket has closed (at once when it already has)."""
        self.closed.add_done_callback(lambda future: callback(future.result()))

    async def wait_closed(self, within: float | None = None) -> bool:
        """Waits for the disconnect. True when the socket closed, False on timeout."""
        try:
            await asyncio.wait_for(asyncio.shield(self.closed), within)
        except TimeoutError:
            return False
        return True

    # -- inbound ------------------------------------------------------------------------------------------------------

    def on_message(self, handler: MessageHandler) -> None:
        """Starts delivering messages: first the ones held until now, in order, then live ones."""
        self._handler = handler
        if self._dropped > 0:
            self.log.warning("messages dropped during the handshake", dropped=self._dropped)
        pending, self._pending = self._pending, []
        for data, is_binary in pending:
            self._deliver(handler, data, is_binary)

    def _deliver(self, handler: MessageHandler, data: str | bytes, is_binary: bool) -> None:
        try:
            handler(data, is_binary)
        except Exception as err:
            self.log.error("websocket message handler failed", err=repr(err))

    async def _read(self) -> None:
        code = 1006
        try:
            while True:
                message = await self.websocket.receive()
                if message["type"] == "websocket.disconnect":
                    code = int(message.get("code") or 1005)
                    break
                if message["type"] != "websocket.receive":
                    continue
                if message.get("bytes") is not None:
                    data: str | bytes = message["bytes"]
                    is_binary = True
                else:
                    data = message.get("text") or ""
                    is_binary = False
                if self._handler is not None:
                    self._deliver(self._handler, data, is_binary)
                elif len(self._pending) < MAX_PENDING_MESSAGES:
                    self._pending.append((data, is_binary))
                else:
                    self._dropped += 1
        except asyncio.CancelledError:
            raise
        except Exception as err:
            self.log.debug("websocket read ended", err=repr(err))
        finally:
            self._open = False
            if not self.closed.done():
                self.closed.set_result(self._close_sent if self._close_sent is not None else code)
            self._queue.put_nowait(None)

    # -- outbound -----------------------------------------------------------------------------------------------------

    def send_text(self, text: str) -> None:
        """Queues a text frame; dropped when the socket isn't open."""
        if not self.is_open:
            return
        self._buffered += len(text)
        self._queue.put_nowait(("text", text, len(text)))

    def close(self, code: int, reason: str) -> None:
        """Queues the close frame (after everything already queued). Safe to call on a socket that is closing."""
        if not self._open:
            return
        self._open = False
        self._close_sent = code
        self._queue.put_nowait(("close", code, reason))

    def terminate(self) -> None:
        """Drops the connection without waiting for the client: nothing queued is sent."""
        was_open = self._open
        self._open = False
        if self._writer is not None:
            self._writer.cancel()
        if was_open and not self.closed.done():
            task = asyncio.ensure_future(self._force_close())
            self._background.add(task)
            task.add_done_callback(self._background.discard)

    async def _force_close(self) -> None:
        with contextlib.suppress(Exception):
            await asyncio.wait_for(self.websocket.close(code=1013), 2)

    async def _write(self) -> None:
        try:
            while True:
                item = await self._queue.get()
                if item is None:
                    return
                kind, a, b = item
                if kind == "text":
                    try:
                        await self.websocket.send_text(a)
                    finally:
                        self._buffered -= b
                else:
                    if self.websocket.application_state != WebSocketState.DISCONNECTED:
                        await self.websocket.close(code=a, reason=b)
                    return
        except asyncio.CancelledError:
            raise
        except Exception as err:
            # The peer is gone (or the send failed): the reader reports the disconnect.
            self.log.debug("websocket write ended", err=repr(err))
            self._open = False

    async def aclose(self) -> None:
        """Stops the reader and writer (the endpoint is done with the socket)."""
        for task in (self._reader, self._writer):
            if task is not None and not task.done():
                task.cancel()
        for task in (self._reader, self._writer):
            if task is not None:
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task
        if not self.closed.done():
            self.closed.set_result(1006)

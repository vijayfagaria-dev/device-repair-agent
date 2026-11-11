"""Small helpers shared by the Deepgram adapters (websockets, asyncio)."""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any

from websockets.asyncio.client import ClientConnection
from websockets.protocol import State


def is_open(ws: ClientConnection) -> bool:
    return ws.state is State.OPEN


def is_closed(ws: ClientConnection) -> bool:
    return ws.state is State.CLOSED


def terminate(ws: ClientConnection) -> None:
    """Drops the connection without a closing handshake (ws.terminate())."""
    transport = getattr(ws, "transport", None)
    if transport is not None:
        transport.abort()


class Outbox:
    """Ordered, non-blocking sends: ``put`` from sync code, a writer task awaits ``ws.send`` in order."""

    def __init__(self, ws: ClientConnection) -> None:
        self._ws = ws
        self._queue: asyncio.Queue[str | bytes] = asyncio.Queue()
        self._task = asyncio.get_running_loop().create_task(self._run())

    def put(self, data: str | bytes) -> None:
        if is_open(self._ws):
            self._queue.put_nowait(data)

    async def _run(self) -> None:
        while True:
            data = await self._queue.get()
            try:
                if is_open(self._ws):
                    await self._ws.send(data)
            except Exception:
                pass
            finally:
                self._queue.task_done()

    async def drain(self, seconds: float = 1.0) -> None:
        with contextlib.suppress(Exception):
            await asyncio.wait_for(self._queue.join(), seconds)

    def stop(self) -> None:
        self._task.cancel()


def spawn(coro: Any, keep: set[asyncio.Task[Any]]) -> asyncio.Task[Any]:
    """Runs ``coro`` in the background, keeping a reference until it is done."""
    task = asyncio.get_running_loop().create_task(coro)
    keep.add(task)
    task.add_done_callback(keep.discard)
    return task

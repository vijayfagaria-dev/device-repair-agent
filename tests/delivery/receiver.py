"""A local HTTP receiver whose behaviour each test scripts (port of the `receiver` helper in worker.test.ts)."""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from app.config import Secret

#: A status, "hang" (never answers: the worker's timeout fires), "drop" (closes the socket) or a redirect.
Verdict = int | str | dict[str, str]


@dataclass
class Received:
    key: str | None
    secret: str | None
    content_type: str | None
    body: dict[str, Any]
    at: float


@dataclass
class Receiver:
    url: Secret
    received: list[Received] = field(default_factory=list)
    _server: asyncio.base_events.Server | None = None
    _writers: set[asyncio.StreamWriter] = field(default_factory=set)

    async def close(self) -> None:
        for writer in list(self._writers):
            writer.close()
        if self._server is not None:
            self._server.close()
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self._server.wait_closed(), 1)


async def start_receiver(respond: Callable[[Received, int], Verdict]) -> Receiver:
    receiver = Receiver(url=Secret(""))

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        receiver._writers.add(writer)
        try:
            head = await reader.readuntil(b"\r\n\r\n")
            lines = head.decode("latin-1").split("\r\n")
            headers = {k.lower(): v.strip() for k, _, v in (line.partition(":") for line in lines[1:] if line)}
            body = await reader.readexactly(int(headers.get("content-length", "0")))
            item = Received(
                key=headers.get("idempotency-key"),
                secret=headers.get("x-hook-secret"),
                content_type=headers.get("content-type"),
                body=json.loads(body.decode("utf-8")),
                at=time.time() * 1000,
            )
            receiver.received.append(item)
            verdict = respond(item, len(receiver.received) - 1)
            if verdict == "hang":
                await asyncio.sleep(3600)
            elif verdict == "drop":
                writer.transport.abort()
            elif isinstance(verdict, dict):
                writer.write(
                    f"HTTP/1.1 302 Found\r\nlocation: {verdict['redirect']}\r\ncontent-length: 0\r\n\r\n".encode()
                )
                await writer.drain()
            else:
                assert isinstance(verdict, int)
                writer.write(
                    f"HTTP/1.1 {verdict} X\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{{}}".encode()
                )
                await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError, asyncio.CancelledError):
            pass
        finally:
            receiver._writers.discard(writer)
            writer.close()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    receiver._server = server
    port = server.sockets[0].getsockname()[1]
    receiver.url = Secret(f"http://127.0.0.1:{port}/hooks/records")
    return receiver

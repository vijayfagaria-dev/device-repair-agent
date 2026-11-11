"""A real listening app (sockets can't go through an ASGI transport with real Origin headers) and a small WebSocket client
(port of server/test/helpers/app.ts).

`start_app(db, **options)` builds the pure app (`app.main.build_app`) and serves it with uvicorn on a free port in this
event loop; `connect(url)` opens a socket with the `websockets` client and records what arrives; `RawSocket` is a bare
TCP client that completes the upgrade and then never answers a ping (the `autoPong: false` of the TS client).
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import os
import struct
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI
from websockets.asyncio.client import connect as ws_connect

from app.db.pool import Database
from app.logging import create_logger
from app.main import AppServer, build_app, create_app, server_config
from app.ws.keep_alive import KeepAliveOptions

ORIGIN = "https://repair.example.com"


class _Server(AppServer):
    """The app's server without signal handlers (several run in one test process)."""

    def capture_signals(self) -> contextlib.AbstractContextManager[None]:  # type: ignore[override]
        return contextlib.nullcontext()


@dataclass
class RunningApp:
    app: FastAPI
    http: str
    ws: str
    server: _Server
    task: asyncio.Task[None]

    async def close(self) -> None:
        """Stops the server the way a SIGTERM does (sockets get 1012, the lifespan shuts down)."""
        self.server.should_exit = True
        await asyncio.wait_for(self.task, 30)

    def client(self, **kwargs: Any) -> httpx.AsyncClient:
        return httpx.AsyncClient(base_url=self.http, **kwargs)

    @property
    def runtime(self) -> Any:
        return self.app.state.ws_runtime

    @property
    def port(self) -> int:
        return int(urlsplit(self.http).port or 0)


async def serve(
    app: FastAPI,
    *,
    keep_alive: KeepAliveOptions | None = None,
    lifespan: str = "off",
    host: str = "127.0.0.1",
    port: int = 0,
) -> RunningApp:
    config = server_config(app, host=host, port=port, keep_alive=keep_alive, lifespan=lifespan)
    server = _Server(config, app)
    task = asyncio.ensure_future(server.serve())
    for _ in range(1000):
        if server.started:
            break
        if task.done():
            task.result()
            raise RuntimeError("the server stopped before it started")
        await asyncio.sleep(0.01)
    else:
        raise RuntimeError("the server did not start")
    bound = server.servers[0].sockets[0].getsockname()[1]
    address = f"http://127.0.0.1:{bound}"
    return RunningApp(app=app, http=address, ws=address.replace("http", "ws", 1), server=server, task=task)


async def start_app(db: Database, **options: Any) -> RunningApp:
    """A listening app over `db` (TS `startApp`): `build_app` options, plus `keep_alive` (the sockets' ping settings)."""
    keep_alive = options.pop("keep_alive", None)
    settings: dict[str, Any] = {
        "log": create_logger("silent"),
        "web_dist_dir": "/nonexistent",
        "require_web_build": False,
        "public_origin": ORIGIN,
    }
    settings.update(options)
    return await serve(build_app(db=db, **settings), keep_alive=keep_alive)


async def start_full_app(config: Any, **options: Any) -> RunningApp:
    """The whole server (`create_app`: lifespan, recovery, sweeper, outbox) listening on a free port."""
    keep_alive = options.get("keep_alive")
    options.setdefault("log", create_logger("silent"))
    options.setdefault("web_dist_dir", "/nonexistent")
    return await serve(create_app(config, **options), keep_alive=keep_alive, lifespan="on")


@dataclass(frozen=True)
class Closed:
    code: int
    reason: str


class TestSocket:
    """A WebSocket client that records every message (text parsed as JSON, binary as bytes) and how it closed."""

    __test__ = False

    def __init__(self, url: str, *, origin: str | None = ORIGIN, headers: dict[str, str] | None = None) -> None:
        self.url = url
        self.messages: list[Any] = []
        self.opened: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self.closed: asyncio.Future[Closed] = asyncio.get_running_loop().create_future()
        self._ws: Any = None
        self._waiters: list[asyncio.Event] = []
        self._origin = origin
        self._headers = headers or {}
        self._task = asyncio.ensure_future(self._run())
        self.opened.add_done_callback(lambda f: f.cancelled() or f.exception())  # never "exception never retrieved"

    async def _run(self) -> None:
        try:
            self._ws = await ws_connect(
                self.url,
                origin=self._origin,  # type: ignore[arg-type]
                additional_headers=self._headers,
                ping_interval=None,
                max_size=None,
                open_timeout=10,
                compression=None,
            )
        except Exception as err:
            self.opened.set_exception(err)
            self.closed.set_result(Closed(1006, ""))
            return
        self.opened.set_result(None)
        try:
            async for message in self._ws:
                self.messages.append(message if isinstance(message, bytes) else json.loads(message))
                for waiter in self._waiters:
                    waiter.set()
        except Exception:
            pass
        self.closed.set_result(Closed(self._ws.close_code or 1006, self._ws.close_reason or ""))
        for waiter in self._waiters:
            waiter.set()

    @property
    def is_open(self) -> bool:
        return self._ws is not None and self._ws.state.name == "OPEN"

    async def send(self, data: str | bytes) -> None:
        await self._ws.send(data)

    async def close(self, code: int = 1000) -> None:
        if self._ws is not None:
            with contextlib.suppress(Exception):
                await self._ws.close(code)

    async def wait_for_messages(self, count: int, within: float = 3.0) -> list[Any]:
        deadline = asyncio.get_running_loop().time() + within
        while len(self.messages) < count:
            waiter = asyncio.Event()
            self._waiters.append(waiter)
            try:
                await asyncio.wait_for(waiter.wait(), max(0.0, deadline - asyncio.get_running_loop().time()))
            except TimeoutError:
                raise AssertionError(f"got {len(self.messages)} of {count} messages") from None
            finally:
                self._waiters.remove(waiter)
        return self.messages


def connect(url: str, *, origin: str | None = ORIGIN, headers: dict[str, str] | None = None) -> TestSocket:
    return TestSocket(url, origin=origin, headers=headers)


async def closed_within(socket: Any, ms: float) -> Closed | str:
    """The close, or "open" if the socket is still open after `ms`."""
    try:
        return await asyncio.wait_for(asyncio.shield(socket.closed), ms / 1000)
    except TimeoutError:
        return "open"


class RawSocket:
    """A bare TCP client: completes the upgrade, then reads and discards everything and never writes again, so it answers
    no ping and no close (the TS client with `autoPong: false`). `closed` resolves with the close code if a close frame
    arrived, 1006 when the connection just ended."""

    def __init__(self, url: str, *, origin: str | None = ORIGIN) -> None:
        self.url = url
        self.origin = origin
        self.messages: list[Any] = []
        self.opened: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self.closed: asyncio.Future[Closed] = asyncio.get_running_loop().create_future()
        self._writer: asyncio.StreamWriter | None = None
        self._task = asyncio.ensure_future(self._run())
        self.opened.add_done_callback(lambda f: f.cancelled() or f.exception())

    async def _run(self) -> None:
        parts = urlsplit(self.url)
        try:
            reader, writer = await asyncio.open_connection(parts.hostname, parts.port)
        except OSError as err:
            self.opened.set_exception(err)
            self.closed.set_result(Closed(1006, ""))
            return
        self._writer = writer
        path = parts.path + (f"?{parts.query}" if parts.query else "")
        lines = [
            f"GET {path} HTTP/1.1",
            f"Host: {parts.hostname}:{parts.port}",
            "Upgrade: websocket",
            "Connection: Upgrade",
            f"Sec-WebSocket-Key: {base64.b64encode(os.urandom(16)).decode()}",
            "Sec-WebSocket-Version: 13",
        ]
        if self.origin is not None:
            lines.append(f"Origin: {self.origin}")
        writer.write(("\r\n".join(lines) + "\r\n\r\n").encode())
        await writer.drain()
        buffer = b""
        code = 1006
        try:
            while b"\r\n\r\n" not in buffer:
                chunk = await reader.read(4096)
                if not chunk:
                    raise ConnectionError("closed during the handshake")
                buffer += chunk
            buffer = buffer.split(b"\r\n\r\n", 1)[1]
            self.opened.set_result(None)
            while True:
                while len(buffer) >= 2:
                    opcode = buffer[0] & 0x0F
                    length = buffer[1] & 0x7F
                    offset = 2
                    if length == 126:
                        if len(buffer) < 4:
                            break
                        length = struct.unpack("!H", buffer[2:4])[0]
                        offset = 4
                    elif length == 127:
                        if len(buffer) < 10:
                            break
                        length = struct.unpack("!Q", buffer[2:10])[0]
                        offset = 10
                    if len(buffer) < offset + length:
                        break
                    payload = buffer[offset : offset + length]
                    buffer = buffer[offset + length :]
                    if opcode == 8:
                        code = struct.unpack("!H", payload[:2])[0] if len(payload) >= 2 else 1005
                    elif opcode == 1:
                        with contextlib.suppress(ValueError):
                            self.messages.append(json.loads(payload))
                chunk = await reader.read(4096)
                if not chunk:
                    break
                buffer += chunk
        except (ConnectionError, OSError):
            pass
        finally:
            if not self.opened.done():
                self.opened.set_exception(ConnectionError("the upgrade did not complete"))
            if not self.closed.done():
                self.closed.set_result(Closed(code, ""))

    def destroy(self) -> None:
        if self._writer is not None:
            self._writer.transport.abort()


def raw_connect(url: str, *, origin: str | None = ORIGIN) -> RawSocket:
    return RawSocket(url, origin=origin)


async def wait_for(check: Callable[[], Any], what: str, within: float = 3.0, interval: float = 0.01) -> None:
    """Polls `check` (sync or async) until it is truthy; raises AssertionError after `within` seconds."""
    deadline = asyncio.get_running_loop().time() + within
    while True:
        result = check()
        if asyncio.iscoroutine(result):
            result = await result
        if result:
            return
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError(f"timed out waiting for {what}")
        await asyncio.sleep(interval)

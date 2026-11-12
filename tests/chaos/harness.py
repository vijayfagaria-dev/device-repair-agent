"""A spawnable server for the chaos tests (P8-T03): `python -m app` as a real process against a throwaway database, with
an armed failpoint (app/failpoints.py: it SIGKILLs itself there). The receiver is the server's own stub, which stores into
received_records, so "exactly one stored record, duplicates only count" is asked of the database.
(Port of server/test/chaos/harness.ts.)
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import signal
import sys
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import asyncpg
import httpx

from app.db.migrate import migrate
from app.db.pool import Database, create_database
from tests.helpers.env import FAKE, valid_env

ROOT = Path(__file__).resolve().parents[2]
CHAOS_ORIGIN = "http://localhost:8080"


@dataclass(frozen=True)
class Exit:
    """How a process ended: `code` is None when a signal killed it (then `signal` is its name, e.g. "SIGKILL")."""

    code: int | None
    signal: str | None


def _process_env(env: dict[str, str | None]) -> dict[str, str]:
    base = {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "LANG", "TMPDIR")}
    base.update({k: v for k, v in env.items() if v is not None})
    return base


def _exit_of(returncode: int) -> Exit:
    if returncode < 0:
        return Exit(None, signal.Signals(-returncode).name)
    return Exit(returncode, None)


class Spawned:
    def __init__(self, proc: asyncio.subprocess.Process) -> None:
        self.proc = proc
        self.lines: list[str] = []
        self.address: str | None = None
        loop = asyncio.get_running_loop()
        self._listening: asyncio.Future[str] = loop.create_future()
        self._listening.add_done_callback(lambda f: f.cancelled() or f.exception())  # a server that dies on purpose
        self._reader = asyncio.ensure_future(self._read())
        self._exit: asyncio.Future[Exit] = asyncio.ensure_future(self._wait())

    async def _read(self) -> None:
        assert self.proc.stdout is not None
        async for raw in self.proc.stdout:
            line = raw.decode(errors="replace")
            self.lines.append(line)
            if not self._listening.done() and '"server listening"' in line:
                with contextlib.suppress(ValueError, KeyError):
                    self._listening.set_result(json.loads(line)["address"])

    async def _wait(self) -> Exit:
        code = await self.proc.wait()
        await self._reader
        result = _exit_of(code)
        if not self._listening.done():
            self._listening.set_exception(
                RuntimeError(f"server exited ({result.signal or result.code}) before listening")
            )
        return result

    @property
    def exit(self) -> asyncio.Future[Exit]:
        return self._exit

    @property
    def exited(self) -> bool:
        return self.proc.returncode is not None

    async def listening(self, seconds: float = 25) -> str:
        """The base URL once the server listens; raises if it exits first or does not start in time."""
        try:
            self.address = await asyncio.wait_for(asyncio.shield(self._listening), seconds)
        except TimeoutError:
            raise RuntimeError(f"server did not start:\n{self.output()}") from None
        return self.address

    def output(self) -> str:
        return "".join(self.lines)

    def logs(self) -> list[dict[str, Any]]:
        """Output lines that are JSON log records, parsed."""
        records: list[dict[str, Any]] = []
        for line in self.lines:
            if line.startswith("{"):
                with contextlib.suppress(ValueError):
                    records.append(json.loads(line))
        return records

    def log(self, msg: str) -> dict[str, Any] | None:
        return next((r for r in self.logs() if r.get("msg") == msg), None)

    async def stop(self) -> Exit:
        """SIGTERM and wait for the exit."""
        if self.proc.returncode is None:
            self.proc.send_signal(signal.SIGTERM)
        return await asyncio.wait_for(asyncio.shield(self._exit), 30)

    async def kill(self) -> None:
        if self.proc.returncode is None:
            self.proc.kill()
        await asyncio.shield(self._exit)


async def spawn_server(
    database_url: str, *, failpoints: str | None = None, env: dict[str, str | None] | None = None
) -> Spawned:
    settings = valid_env(
        HOST="127.0.0.1",
        PORT="0",
        NODE_ENV="test",
        PUBLIC_ORIGIN=CHAOS_ORIGIN,
        DATABASE_URL=database_url,
        ALLOW_TEST_API="true",
        TEST_API_TOKEN=FAKE["TEST_API_TOKEN"],
    )
    if failpoints:
        settings["FAILPOINTS"] = failpoints
    settings.update(env or {})
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "app",
        cwd=ROOT,
        env=_process_env(settings),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    return Spawned(proc)


async def exits_within(server: Spawned, seconds: float = 20) -> Exit:
    """Waits for the process to exit, failing (and killing it) if it doesn't in time: a failpoint that never fires."""
    try:
        return await asyncio.wait_for(asyncio.shield(server.exit), seconds)
    except TimeoutError:
        await server.kill()
        raise AssertionError(
            f"the server did not die at its failpoint within {seconds} s:\n{server.output()}"
        ) from None


async def until(check: Callable[[], Awaitable[bool]], what: str, seconds: float = 15) -> None:
    deadline = asyncio.get_running_loop().time() + seconds
    while not await check():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError(f"timed out waiting for {what}")
        await asyncio.sleep(0.05)


async def finalize_request(address: str, session_id: str) -> httpx.Response:
    async with httpx.AsyncClient(timeout=30) as client:
        return await client.post(
            f"{address}/api/sessions/{session_id}/finalize",
            headers={"authorization": f"Bearer {FAKE['TEST_API_TOKEN']}"},
        )


@dataclass
class ChaosDatabase:
    """A migrated database of its own (asyncpg ignores a URL's search_path, so a schema cannot isolate a spawned server)."""

    name: str
    url: str
    db: Database
    admin_url: str

    async def drop(self) -> None:
        await self.db.close()
        admin = await asyncpg.connect(self.admin_url)
        try:
            await admin.execute(f"DROP DATABASE {self.name} WITH (FORCE)")
        finally:
            await admin.close()


async def create_chaos_database(base_url: str, *, max_size: int = 8) -> ChaosDatabase:
    name = "chaos_" + os.urandom(5).hex()
    admin = await asyncpg.connect(base_url)
    try:
        await admin.execute(f"CREATE DATABASE {name}")
    finally:
        await admin.close()
    url = urlunsplit(urlsplit(base_url)._replace(path=f"/{name}"))
    db = await create_database(url, max_size=max_size)
    await migrate(db.pool)
    return ChaosDatabase(name=name, url=url, db=db, admin_url=base_url)

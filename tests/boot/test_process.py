"""Starts `python -m app` as a real process against the throwaway test database: configuration errors, migrations on first
and second boot, concurrent first boots, an unreachable database, and a clean SIGTERM shutdown.
(Port of server/test/boot.test.ts.) Needs `web/dist` for the UI assertions (`npm run build -w web`).
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import subprocess
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import asyncpg
import httpx
import pytest

from tests.helpers.env import FAKE_SECRET_VALUES, valid_env

ROOT = Path(__file__).resolve().parents[2]
needs_web = pytest.mark.skipif(not (ROOT / "web" / "dist" / "index.html").exists(), reason="web/dist is not built")


def process_env(env: dict[str, str | None]) -> dict[str, str]:
    base = {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "LANG", "TMPDIR")}
    base.update({k: v for k, v in env.items() if v is not None})
    return base


def server_env(database_url: str, node_env: str = "test") -> dict[str, str | None]:
    return valid_env(
        HOST="127.0.0.1",
        PORT="0",
        NODE_ENV=node_env,
        PUBLIC_ORIGIN="https://repair.example.com",
        DATABASE_URL=database_url,
    )


def expect_no_fake_values(output: str) -> None:
    for value in FAKE_SECRET_VALUES:
        assert value not in output


def run_once(env: dict[str, str | None], timeout: float = 25) -> tuple[int, str]:
    result = subprocess.run(
        [sys.executable, "-m", "app"],
        cwd=ROOT,
        env=process_env(env),
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    return result.returncode, result.stdout + result.stderr


def migration_log(output: str) -> dict[str, Any]:
    for line in output.splitlines():
        if '"msg":"migrations complete"' in line:
            return json.loads(line)  # type: ignore[no-any-return]
    raise AssertionError(f"no migrations log line:\n{output}")


class Server:
    def __init__(self, proc: asyncio.subprocess.Process) -> None:
        self.proc = proc
        self.lines: list[str] = []
        self.address = ""
        self._ready: asyncio.Future[str] = asyncio.get_running_loop().create_future()
        self._reader = asyncio.ensure_future(self._read())

    async def _read(self) -> None:
        assert self.proc.stdout is not None
        async for raw in self.proc.stdout:
            line = raw.decode()
            self.lines.append(line)
            if '"server listening"' in line and not self._ready.done():
                self._ready.set_result(json.loads(line)["address"])
        if not self._ready.done():
            self._ready.set_exception(RuntimeError("server exited before listening:\n" + self.output()))

    def output(self) -> str:
        return "".join(self.lines)

    async def stop(self) -> int:
        if self.proc.returncode is None:
            self.proc.send_signal(signal.SIGTERM)
        code = await asyncio.wait_for(self.proc.wait(), 20)
        await self._reader
        return code


@asynccontextmanager
async def started(env: dict[str, str | None]) -> AsyncIterator[Server]:
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "app",
        cwd=ROOT,
        env=process_env(env),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    server = Server(proc)
    try:
        server.address = await asyncio.wait_for(server._ready, 30)
        yield server
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()


@pytest.fixture
async def empty_database_url(test_database_url: str) -> AsyncIterator[str]:
    """An empty database of its own in the test cluster (what a first boot meets)."""
    name = "boot_" + os.urandom(5).hex()
    admin = await asyncpg.connect(test_database_url)
    await admin.execute(f"CREATE DATABASE {name}")
    parts = urlsplit(test_database_url)
    try:
        yield urlunsplit(parts._replace(path=f"/{name}"))
    finally:
        await admin.execute(f"DROP DATABASE {name} WITH (FORCE)")
        await admin.close()


class TestConfiguration:
    def test_exits_non_zero_naming_a_missing_key_without_printing_any_value(self):
        code, output = run_once(valid_env(GROQ_API_KEY=None, NODE_ENV="test"))
        assert code == 1
        assert "GROQ_API_KEY is missing" in output
        expect_no_fake_values(output)

    def test_names_an_invalid_value_without_echoing_it(self):
        code, output = run_once(valid_env(HOOK_SECRET="short-hook-secret-value", NODE_ENV="test"))
        assert code == 1
        assert "HOOK_SECRET is invalid" in output
        assert "short-hook-secret-value" not in output
        expect_no_fake_values(output)


class TestDatabase:
    @needs_web
    async def test_migrates_an_empty_database_serves_the_ui_and_readiness_and_shuts_down_cleanly(
        self, empty_database_url: str
    ):
        async with started(server_env(empty_database_url, "production")) as server:
            try:
                log = migration_log(server.output())
                assert log["applied"] == ["001_init"] and log["count"] == 1
                async with httpx.AsyncClient(base_url=server.address) as client:
                    page = await client.get("/")
                    assert page.status_code == 200
                    assert '<div id="root"></div>' in page.text
                    api = await client.get("/api/x")
                    assert api.status_code == 404 and api.json() == {"error": "not_found"}
                    assert (await client.get("/healthz")).json() == {"status": "ok"}
                    ready = await client.get("/readyz")
                    assert ready.status_code == 200 and ready.json() == {"status": "ok"}
            finally:
                assert await server.stop() == 0
        assert '"msg":"shutdown complete"' in server.output()
        expect_no_fake_values(server.output())

    async def test_applies_0_migrations_on_the_second_boot(self, empty_database_url: str):
        env = server_env(empty_database_url)
        async with started(env) as first:
            assert migration_log(first.output())["count"] == 1
            assert await first.stop() == 0
        async with started(env) as server:
            log = migration_log(server.output())
            assert log["applied"] == [] and log["count"] == 0
            assert await server.stop() == 0

    async def test_applies_each_migration_once_when_two_servers_boot_at_the_same_time(self, empty_database_url: str):
        env = server_env(empty_database_url)
        async with started(env) as one, started(env) as two:
            applied = [a for s in (one, two) for a in migration_log(s.output())["applied"]]
            assert applied == ["001_init"]
            assert await one.stop() == 0
            assert await two.stop() == 0

    def test_retries_once_then_exits_non_zero_without_the_password_when_the_database_is_unreachable(self):
        code, output = run_once(server_env("postgresql://someone:fake-db-password-000@127.0.0.1:1/none"), timeout=40)
        assert code == 1
        assert "database not reachable; retrying once" in output
        assert "server failed to start" in output
        expect_no_fake_values(output)

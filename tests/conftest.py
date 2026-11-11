"""Shared fixtures: a throwaway Postgres for the whole run, and one migrated schema per test.

- TEST_DATABASE_URL set (CI: a Postgres service container): use it.
- Otherwise a temporary cluster is created with local Postgres binaries (PG_BIN, Homebrew postgresql@18, or pg_config
  on PATH), started on a free port with durability off, and deleted after the run.

Tests never touch the real database.
"""

from __future__ import annotations

import contextlib
import os
import shutil
import socket
import subprocess
import tempfile
import time
from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import asyncpg
import pytest

from tests.helpers.db import TestSchema, create_migrated_schema


def _find_postgres_bin() -> Path:
    candidates = [os.environ.get("PG_BIN"), "/opt/homebrew/opt/postgresql@18/bin", "/usr/local/opt/postgresql@18/bin"]
    with contextlib.suppress(OSError, subprocess.CalledProcessError):
        candidates.append(
            subprocess.run(["pg_config", "--bindir"], capture_output=True, text=True, check=True).stdout.strip()
        )
    for candidate in candidates:
        if candidate and (Path(candidate) / "initdb").exists() and (Path(candidate) / "postgres").exists():
            return Path(candidate)
    raise RuntimeError(
        "No test database. Set TEST_DATABASE_URL to a disposable Postgres, or install Postgres 18 "
        "(brew install postgresql@18) or set PG_BIN to its bin directory."
    )


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="session")
def test_database_url() -> Iterator[str]:
    if url := os.environ.get("TEST_DATABASE_URL"):
        yield url
        return
    bin_dir = _find_postgres_bin()
    data = Path(tempfile.mkdtemp(prefix="repair-agent-pg-"))
    port = _free_port()
    subprocess.run(
        [bin_dir / "initdb", "-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8"],
        check=True,
        capture_output=True,
    )
    log = data / "server.log"
    proc = subprocess.Popen(
        [
            bin_dir / "postgres",
            "-D",
            data,
            "-p",
            str(port),
            "-h",
            "127.0.0.1",
            "-k",
            str(data),
            "-c",
            "fsync=off",
            "-c",
            "synchronous_commit=off",
            "-c",
            "full_page_writes=off",
            "-c",
            "max_connections=200",
        ],
        stdout=log.open("w"),
        stderr=subprocess.STDOUT,
    )
    url = f"postgresql://postgres@127.0.0.1:{port}/postgres"
    deadline = time.time() + 20
    while True:
        if proc.poll() is not None:
            raise RuntimeError(f"test Postgres exited early:\n{log.read_text()}")
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                break
        except OSError:
            if time.time() > deadline:
                proc.kill()
                raise RuntimeError("test Postgres did not start in 20 s") from None
            time.sleep(0.1)
    try:
        yield url
    finally:
        proc.terminate()
        proc.wait(timeout=10)
        shutil.rmtree(data, ignore_errors=True)


@pytest.fixture
async def schema(test_database_url: str) -> AsyncIterator[TestSchema]:
    """A fresh schema with the migrations applied, and a pool on it (`schema.db`, `schema.url`). Dropped after the test."""
    test_schema = await create_migrated_schema(test_database_url, "t")
    try:
        yield test_schema
    finally:
        await test_schema.drop()


@pytest.fixture
async def db(schema: TestSchema):  # type: ignore[no-untyped-def]
    """The `Database` of the test's fresh schema."""
    return schema.db


@pytest.fixture
async def admin(test_database_url: str) -> AsyncIterator[asyncpg.Connection]:
    conn = await asyncpg.connect(test_database_url)
    try:
        yield conn
    finally:
        await conn.close()

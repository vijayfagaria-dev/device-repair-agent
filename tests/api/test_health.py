"""Port of server/test/health.test.ts: /healthz never touches the database; /readyz does (asserted with the pool's
checkout counter)."""

from __future__ import annotations

from typing import Any

from app.db.pool import create_database
from tests.helpers.http_app import build_http_app, client_for


async def test_healthz_makes_zero_database_queries(schema: Any) -> None:
    fresh = await schema.open()
    try:
        async with client_for(build_http_app(fresh)) as client:
            before = fresh.stats.acquired
            for _ in range(25):
                res = await client.get("/healthz")
                assert res.json() == {"status": "ok"}
            assert fresh.stats.acquired - before == 0
            assert fresh.pool.get_size() == 0
    finally:
        await fresh.close()


async def test_readyz_queries_the_database_and_returns_200(db: Any) -> None:
    async with client_for(build_http_app(db)) as client:
        before = db.stats.acquired
        res = await client.get("/readyz")
        assert res.status_code == 200
        assert res.json() == {"status": "ok"}
        assert res.headers["cache-control"] == "no-store"
        assert db.stats.acquired - before == 1


async def test_readyz_returns_503_when_the_database_is_unreachable() -> None:
    down = await create_database("postgresql://nobody@127.0.0.1:1/none")
    try:
        async with client_for(build_http_app(down)) as client:
            res = await client.get("/readyz")
            assert res.status_code == 503
            assert res.json() == {"status": "unavailable"}
    finally:
        down.pool.terminate()

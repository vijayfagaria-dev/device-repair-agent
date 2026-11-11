"""Port of server/test/web.test.ts: static UI, SPA fallback, 404 policy, /healthz, the missing build."""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from app.api.web import SERVER_PREFIXES
from app.db.pool import create_database
from tests.helpers.http_app import build_http_app, client_for

INDEX_HTML = '<!doctype html><html><body><div id="root"></div></body></html>'


@pytest.fixture
async def site(tmp_path: Path) -> AsyncIterator[tuple[httpx.AsyncClient, Path, FastAPI]]:
    root = tmp_path
    dist = root / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text(INDEX_HTML)
    (dist / "assets" / "app-abc123.js").write_text("console.log(1);")
    (dist / ".env").write_text("SHOULD_NOT_BE_SERVED=1")
    (root / "outside.txt").write_text("outside the web root")
    # Never queried by these tests; static hosting doesn't touch the database.
    db = await create_database("postgresql://nobody@127.0.0.1:1/none")
    app = build_http_app(db, web_dist_dir=dist, require_web_build=True, public_origin="http://localhost:8080")

    @app.get("/api/boom")
    async def boom() -> None:
        raise RuntimeError("database password is hunter2")

    # Routes added after mount sit behind the catch-all; put the test route first.
    app.router.routes.insert(0, app.router.routes.pop())
    async with client_for(app) as client:
        yield client, root, app
    db.pool.terminate()


async def test_get_root_serves_the_ui_with_no_cache(site) -> None:  # type: ignore[no-untyped-def]
    client, _, _ = site
    res = await client.get("/")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/html")
    assert res.headers["cache-control"] == "no-cache"
    assert res.text == INDEX_HTML


async def test_serves_the_ui_for_client_side_paths_keeping_the_query_string_working(site) -> None:  # type: ignore[no-untyped-def]
    client, _, _ = site
    for url in ["/?sessionId=1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b", "/claims/123", "/?demo=1", "/apiary", "/chatroom"]:
        res = await client.get(url)
        assert res.status_code == 200, url
        assert res.text == INDEX_HTML, url


async def test_serves_fingerprinted_assets_with_a_long_immutable_cache(site) -> None:  # type: ignore[no-untyped-def]
    client, _, _ = site
    res = await client.get("/assets/app-abc123.js")
    assert res.status_code == 200
    assert "javascript" in res.headers["content-type"]
    assert res.headers["cache-control"] == "public, max-age=31536000, immutable"


async def test_get_api_x_returns_a_404_json_not_html(site) -> None:  # type: ignore[no-untyped-def]
    client, _, _ = site
    res = await client.get("/api/x")
    assert res.status_code == 404
    assert res.headers["content-type"].startswith("application/json")
    assert res.json() == {"error": "not_found"}


async def test_never_answers_server_owned_paths_with_the_ui(site) -> None:  # type: ignore[no-untyped-def]
    client, _, _ = site
    for prefix in SERVER_PREFIXES:
        for url in [prefix, f"{prefix}/", f"{prefix}/anything", f"{prefix}/a/b?x=1"]:
            if url in ("/healthz", "/readyz"):
                continue  # real routes
            res = await client.get(url)
            assert res.status_code == 404, url
            assert res.headers["content-type"].startswith("application/json"), url


async def test_returns_404_json_for_a_missing_file_instead_of_html(site) -> None:  # type: ignore[no-untyped-def]
    client, _, _ = site
    for url in ["/assets/missing.js", "/favicon-missing.svg"]:
        res = await client.get(url)
        assert res.status_code == 404, url
        assert res.json() == {"error": "not_found"}, url


async def test_returns_404_json_for_non_get_requests_to_unknown_paths(site) -> None:  # type: ignore[no-untyped-def]
    client, _, _ = site
    res = await client.post("/claims/123", json={})
    assert res.status_code == 404
    assert res.json() == {"error": "not_found"}


async def test_does_not_serve_dotfiles_or_files_outside_the_web_root(site) -> None:  # type: ignore[no-untyped-def]
    client, _, _ = site
    for url in [
        "/.env",
        "/../outside.txt",
        "/..%2foutside.txt",
        "/assets/..%2f..%2foutside.txt",
        "/%2e%2e/outside.txt",
    ]:
        res = await client.get(url)
        assert "SHOULD_NOT_BE_SERVED" not in res.text, url
        assert "outside the web root" not in res.text, url


async def test_hides_internal_error_details_on_5xx(site) -> None:  # type: ignore[no-untyped-def]
    client, _, _ = site
    res = await client.get("/api/boom")
    assert res.status_code == 500
    assert res.json() == {"error": "internal_error"}
    assert "hunter2" not in res.text


async def test_healthz_returns_ok_without_caching(site) -> None:  # type: ignore[no-untyped-def]
    client, _, _ = site
    res = await client.get("/healthz")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}
    assert res.headers["cache-control"] == "no-store"


async def test_fails_to_build_when_the_ui_is_required_production(tmp_path: Path) -> None:
    db = await create_database("postgresql://nobody@127.0.0.1:1/none")
    try:
        with pytest.raises(RuntimeError, match="Web build not found"):
            build_http_app(db, web_dist_dir=tmp_path / "nope", require_web_build=True)
    finally:
        db.pool.terminate()


async def test_serves_the_api_only_when_the_ui_is_optional_development(tmp_path: Path) -> None:
    db = await create_database("postgresql://nobody@127.0.0.1:1/none")
    try:
        api_only = build_http_app(db, web_dist_dir=tmp_path / "nope", require_web_build=False)
        async with client_for(api_only) as client:
            page = await client.get("/")
            assert page.status_code == 404
            assert page.json() == {"error": "not_found"}
            assert (await client.get("/healthz")).status_code == 200
    finally:
        db.pool.terminate()

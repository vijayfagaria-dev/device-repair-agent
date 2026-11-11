"""Port of server/test/security/headers.test.ts: security headers (P10-T02): present on every kind of response, a CSP with
no third parties and no inline allowances, the page's own socket origin in connect-src, HSTS only over https, the
microphone allowed for the page itself only."""

from __future__ import annotations

import re
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest

from app.api.security import content_security_policy, security_headers
from app.config import Secret
from tests.helpers.http_app import build_http_app, client_for

EXPECTED = [
    "content-security-policy",
    "referrer-policy",
    "permissions-policy",
    "x-content-type-options",
    "cross-origin-opener-policy",
    "strict-transport-security",
]


@pytest.fixture
async def client(db: Any, tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    (tmp_path / "index.html").write_text("<!doctype html><title>x</title>")
    app = build_http_app(db, web_dist_dir=tmp_path, require_web_build=True, hook_secret=Secret("h" * 32))
    async with client_for(app) as c:
        yield c


@pytest.mark.parametrize(
    ("url", "status"),
    [
        ("/", 200),  # the page
        ("/some/page", 200),  # a SPA route
        ("/healthz", 200),  # a health check
        ("/api/nothing", 404),  # an API 404
        ("/assets/missing.js", 404),  # a missing asset
        ("/hooks/records", 404),  # a method the route doesn't allow
    ],
)
async def test_carries_every_header(client: httpx.AsyncClient, url: str, status: int) -> None:
    response = await client.get(url)
    assert response.status_code == status
    for name in EXPECTED:
        assert response.headers.get(name), name
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert "microphone=(self)" in response.headers["permissions-policy"]


async def test_also_covers_error_responses_produced_by_the_apps_error_handler(client: httpx.AsyncClient) -> None:
    response = await client.post(
        "/hooks/records", headers={"x-hook-secret": "h" * 32, "content-type": "application/json"}, content="{"
    )
    assert response.status_code == 400
    assert response.headers.get("content-security-policy")


def test_has_a_csp_that_loads_nothing_from_other_origins_and_allows_no_inline_script_or_style() -> None:
    csp = content_security_policy("https://repair.example.com")
    directives = {d.split(" ")[0]: d.split(" ")[1:] for d in csp.split("; ")}
    assert directives["default-src"] == ["'none'"]
    assert directives["script-src"] == ["'self'"]
    assert directives["style-src"] == ["'self'"]
    assert directives["connect-src"] == ["'self'", "wss://repair.example.com"]
    assert directives["frame-ancestors"] == ["'none'"]
    assert directives["object-src"] == ["'none'"]
    assert directives["base-uri"] == ["'none'"]
    assert not re.search(r"unsafe-|\*|https?://(?!repair\.example\.com)", csp)


def test_uses_ws_for_an_http_origin_and_sends_hsts_only_for_https() -> None:
    assert "connect-src 'self' ws://localhost:8080" in content_security_policy("http://localhost:8080")
    assert "strict-transport-security" not in security_headers("http://localhost:8080")
    assert security_headers("https://repair.example.com")["strict-transport-security"] == "max-age=31536000"

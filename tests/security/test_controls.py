"""Port of server/test/security/controls.test.ts, the HTTP controls (P9-T05; architecture section 8, MH6). Each control
has a case here that tries to break it. The cases that need the WebSocket transport (Origin check, message sizes,
640-byte frames, forged select options, another session's file ref, prompt injection, WebSocket session ids and the
new-session limit) belong to the WebSocket and scenario tests.

  Control                                              Test
  session id is a UUIDv4                               "malformed session ids" (HTTP)
  no path traversal (files, static web)                "path traversal"
  file links are signed and expire                     "tampered or expired signatures"
  uploads are checked by their bytes                   "spoofed MIME type"
  the test API needs its token                         "test API without a token"
  the stub receiver needs the secret                   "hooks without the secret"
  rate limits                                          "rate limits" (read API, uploads)
  no secrets in the browser bundle                     "bundle scan"
"""

from __future__ import annotations

import re
import subprocess
import tempfile
import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
import pytest

from app.api.web import DEFAULT_WEB_DIST
from app.config import Secret
from tests.helpers.chat_flow import EXE, PDF, PNG
from tests.helpers.fake import FAKE
from tests.helpers.http_app import build_http_app, client_for
from tests.helpers.session import TEST_SIGNER, test_services

ROOT = Path(__file__).resolve().parents[2]
WEB_DIST = ROOT / "web" / "dist"

# A UUID whose version nibble is 1, not 4 (built from parts: a UUID-shaped literal looks like a key to secret scanners).
WRONG_VERSION_UUID = "-".join(["0b6f4c1e", "3d2a", "1e8b", "9a71", "5c2d8e9f1a3b"])
# Fake keys are assembled at run time for the same reason.
FAKE_GOOGLE_KEY = "".join(["AIza", "SyA0123456789abcdefghijklmnopqrstuv"])


@pytest.fixture
async def guarded(db: Any) -> AsyncIterator[httpx.AsyncClient]:
    """Test API, hooks and tight rate limits on."""
    app = build_http_app(
        db,
        test_api_token=Secret(FAKE["TEST_API_TOKEN"]),
        hook_secret=Secret(FAKE["HOOK_SECRET"]),
        processor=test_services(db).processor,
        signer=TEST_SIGNER,
        web_dist_dir=WEB_DIST if WEB_DIST.exists() else Path(tempfile.mkdtemp()),
        api_rate_limit_per_minute=5,
        uploads_per_minute=4,
    )
    async with client_for(app) as client:
        yield client


@pytest.fixture
async def open_server(db: Any) -> AsyncIterator[httpx.AsyncClient]:
    """No test API, generous limits: the public deployment's shape."""
    app = build_http_app(db, signer=TEST_SIGNER, uploads_per_minute=1000)
    async with client_for(app) as client:
        yield client


async def upload(
    client: httpx.AsyncClient, session_id: str, data: bytes, name: str, content_type: str
) -> httpx.Response:
    return await client.post(f"/sessions/{session_id}/files", files={"file": (name, data, content_type)})


def link_for(file_id: str, now: Any = None) -> str:
    from datetime import UTC, datetime

    link = urlsplit(TEST_SIGNER.sign(file_id, now or datetime.now(UTC)))
    return f"{link.path}?{link.query}"


async def test_malformed_session_ids_are_refused_by_the_read_api_and_uploads_400_and_create_no_session(
    open_server: httpx.AsyncClient, db: Any
) -> None:
    before = await db.pool.fetchval("SELECT count(*)::int FROM sessions")
    for path in ["", "/timeline", "/records"]:
        assert (await open_server.get(f"/api/sessions/not-a-uuid{path}")).status_code == 400
    for bad in ["not-a-uuid", WRONG_VERSION_UUID, "..", "x'; DROP TABLE sessions;--"]:
        assert (await upload(open_server, bad, PDF, "a.pdf", "application/pdf")).status_code in (400, 404), bad
    assert await db.pool.fetchval("SELECT count(*)::int FROM sessions") == before


async def test_files_dotdot_variants_never_serve_anything_outside_a_signed_file(open_server: httpx.AsyncClient) -> None:
    for path in [
        "/files/../package.json",
        "/files/..%2f..%2fpackage.json",
        "/files/%2e%2e%2f%2e%2e%2fserver%2f.env",
        "/files/f1?exp=1&sig=x/../../..",
        "/files/..%5c..%5cpackage.json",
    ]:
        response = await open_server.get(path)
        assert response.status_code in (400, 403, 404), path
        assert not re.search(r'"workspaces"|DATABASE_URL|root:x:', response.text), path


async def test_the_static_web_route_cant_be_escaped_env_source_and_parent_files_are_never_returned(
    guarded: httpx.AsyncClient,
) -> None:
    secretish = [
        "/../server/.env",
        "/%2e%2e/server/.env",
        "/..%2fserver%2f.env",
        "/assets/../../server/.env",
        "/%2e%2e%2f%2e%2e%2fpackage.json",
        "//etc/passwd",
        "/..\\..\\package.json",
    ]
    for path in secretish:
        response = await guarded.get(path)
        assert not re.search(r'DATABASE_URL|GROQ_API_KEY|"workspaces"|root:x:', response.text), path
        assert FAKE["GROQ_API_KEY"] not in response.text, path


async def test_a_changed_signature_expiry_or_file_id_is_403_an_expired_link_is_410_the_right_link_works(
    open_server: httpx.AsyncClient,
) -> None:
    from datetime import UTC, datetime, timedelta

    session_id = str(uuid.uuid4())
    file_id = (await upload(open_server, session_id, PDF, "invoice.pdf", "application/pdf")).json()["url"][
        len("file:") :
    ]
    good = link_for(file_id)
    assert (await open_server.get(good)).status_code == 200
    sig = re.search(r"sig=([A-Za-z0-9_-]+)", good)
    exp = re.search(r"exp=(\d+)", good)
    assert sig and exp
    # The first character: the last base64 character carries unused bits, so changing only it can decode to the same bytes.
    first = "B" if sig.group(1).startswith("A") else "A"
    assert (await open_server.get(good.replace(sig.group(1), first + sig.group(1)[1:]))).status_code == 403
    assert (
        await open_server.get(good.replace(f"exp={exp.group(1)}", f"exp={int(exp.group(1)) + 1}"))
    ).status_code == 403
    assert (await open_server.get(good.replace(f"&sig={sig.group(1)}", ""))).status_code == 403
    assert (await open_server.get(good.replace(file_id, f"{file_id}x"))).status_code == 403
    expired = link_for(file_id, datetime.now(UTC) - timedelta(days=40))
    assert (await open_server.get(expired)).status_code == 410


async def test_a_program_renamed_pdf_a_png_labelled_pdf_and_a_heic_photo_are_refused_415_and_nothing_is_stored(
    open_server: httpx.AsyncClient, db: Any
) -> None:
    id = str(uuid.uuid4())
    heic = bytes([0, 0, 0, 24]) + b"ftypheic" + bytes(16)
    for data, name, content_type in [
        (EXE, "invoice.pdf", "application/pdf"),
        (PNG, "invoice.pdf", "application/pdf"),
        (b"<script>alert(1)</script>", "a.png", "image/png"),
        (heic, "p.heic", "image/heic"),
    ]:
        assert (await upload(open_server, id, data, name, content_type)).status_code == 415, name
    assert await db.pool.fetchval("SELECT count(*)::int FROM files WHERE session_id = $1", id) == 0


async def test_test_api_session_creation_and_finalize_answer_401_with_no_token_a_wrong_one_or_another_secret(
    guarded: httpx.AsyncClient,
) -> None:
    for authorization in [
        None,
        "",
        "Bearer",
        "Bearer wrong",
        f"Bearer {FAKE['HOOK_SECRET']}",
        FAKE["TEST_API_TOKEN"],
        f"bearer {FAKE['TEST_API_TOKEN']}x",
    ]:
        headers = {} if authorization is None else {"authorization": authorization}
        assert (await guarded.post("/api/sessions", headers=headers)).status_code == 401, str(authorization)
        finalize = await guarded.post(f"/api/sessions/{uuid.uuid4()}/finalize", headers=headers)
        assert finalize.status_code == 401, str(authorization)


async def test_the_test_api_does_not_exist_at_all_when_it_is_off(open_server: httpx.AsyncClient) -> None:
    headers = {"authorization": f"Bearer {FAKE['TEST_API_TOKEN']}"}
    assert (await open_server.post("/api/sessions", headers=headers)).status_code == 404
    assert (await open_server.post(f"/api/sessions/{uuid.uuid4()}/finalize", headers=headers)).status_code == 404


async def test_post_hooks_records_answers_401_without_the_secret_and_get_needs_the_test_token_not_the_hook_secret(
    guarded: httpx.AsyncClient,
) -> None:
    for secret in [None, "", "wrong", FAKE["TEST_API_TOKEN"]]:
        headers = {"content-type": "application/json", **({} if secret is None else {"x-hook-secret": secret})}
        response = await guarded.post("/hooks/records", headers=headers, content="{}")
        assert response.status_code == 401, str(secret)
    assert (await guarded.get("/hooks/records")).status_code == 401
    assert (
        await guarded.get("/hooks/records", headers={"authorization": f"Bearer {FAKE['HOOK_SECRET']}"})
    ).status_code == 401


async def test_rate_limits_the_read_api_per_ip_and_uploads_per_ip_each_stop_a_flood(guarded: httpx.AsyncClient) -> None:
    id = uuid.uuid4()
    statuses = [(await guarded.get(f"/api/sessions/{id}")).status_code for _ in range(8)]
    assert len([s for s in statuses if s == 429]) >= 3
    assert all(s in (404, 429) for s in statuses)

    uploads = [(await upload(guarded, str(uuid.uuid4()), PNG, "p.png", "image/png")).status_code for _ in range(8)]
    assert 429 in uploads


class TestBundleScan:
    script = ROOT / "scripts" / "check-bundle-secrets.sh"

    def scan(self, directory: Path, **env: str) -> subprocess.CompletedProcess[str]:
        import os

        return subprocess.run(
            ["bash", str(self.script), str(directory)],
            env={"PATH": os.environ["PATH"], **env},
            capture_output=True,
            text=True,
            check=False,
        )

    @pytest.mark.skipif(not WEB_DIST.exists(), reason="web/dist is not built")
    def test_passes_the_real_production_build(self) -> None:
        result = self.scan(WEB_DIST)
        assert "is clean" in result.stdout + result.stderr
        assert result.returncode == 0

    @pytest.mark.parametrize(
        ("name", "content"),
        [
            ("a Groq key", 'const k="gsk_0123456789abcdefghijABCD"'),
            ("a Google key", f'const k="{FAKE_GOOGLE_KEY}"'),
            ("an OpenAI-style key", 'const k="sk-0123456789abcdefghijklmn"'),
            ("a bearer token", 'fetch(u,{headers:{Authorization:"Bearer abcdefghijklmnopqrstuvwxyz012345"}})'),
            ("a database URL", 'const u="postgresql://user:pass@ep-host.neon.tech/db"'),
            ("a private key", "-----BEGIN PRIVATE KEY-----"),
            ("a server secret name", "process.env.FILE_URL_SECRET"),
            ("the hook secret header", 'headers:{"X-Hook-Secret":"s"}'),
        ],
    )
    def test_fails_on_secret_planted_in_a_bundle_and_never_prints_it(
        self, name: str, content: str, tmp_path: Path
    ) -> None:
        (tmp_path / "index.js").write_text(f"console.log(1);{content};")
        result = self.scan(tmp_path)
        assert result.returncode == 1, name
        assert re.search(r"^LEAK \(", result.stderr, re.MULTILINE)
        assert content[12:30] not in result.stdout + result.stderr

    def test_with_a_secrets_file_fails_when_a_real_value_appears_literally_whatever_its_shape(
        self, tmp_path: Path
    ) -> None:
        value = "a1b2c3d4e5f60718293a4b5c6d7e8f90"
        bundle = tmp_path / "bundle"
        bundle.mkdir()
        (bundle / "app.js").write_text(f'x="{value}"')
        env_file = tmp_path / f"env-{uuid.uuid4()}"
        env_file.write_text(f"DEEPGRAM_API_KEY={value}\nPUBLIC_ORIGIN=https://public.example.com\n")
        result = self.scan(bundle, SECRETS_FILE=str(env_file))
        assert result.returncode == 1
        assert "value of DEEPGRAM_API_KEY" in result.stderr
        assert value not in result.stderr

    def test_a_missing_directory_is_an_error_not_a_pass(self, tmp_path: Path) -> None:
        assert self.scan(tmp_path / f"nope-{uuid.uuid4()}").returncode == 2


def test_default_web_dist_is_the_repo_web_dist() -> None:
    assert DEFAULT_WEB_DIST == WEB_DIST

"""The deployed E2E script (port of server/test/deployed/e2e.test.ts and the live run it stands for).

`TestLive` runs the script against a real deployment and is skipped unless SMOKE_BASE_URL is set (it uses real provider
quota). `TestAgainstALocalDeployment` checks the script's own logic against this repo's app with fake providers: its
assertions can pass, and fail when the system misbehaves. That does NOT prove a deployment works; only the live run does.
The local STT "hears" the WAV's loudness; the LLM is scripted.

    SMOKE_BASE_URL=https://<app>.onrender.com [SMOKE_DATABASE_URL=...] [SMOKE_NO_DB=1] [SMOKE_RESTART=1] \\
        uv run pytest tests/smoke/test_deployed.py -q

Secrets (SMOKE_DATABASE_URL, RENDER_DEPLOY_HOOK_URL) are read from the environment and never printed.
"""

from __future__ import annotations

import json
import math
import os
import re
import socket
import struct
import uuid
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

import asyncpg
import pytest

from app.config import Secret
from app.delivery.worker import OutboxWorker
from app.files.signing import create_file_url_signer
from app.logging import create_logger
from app.main import build_app
from app.session.services import create_session_services
from app.voice.barge_in import BargeInSettings
from app.voice.call_engine import CallTimings
from app.voice.clock import real_clock
from app.voice.fakes.llm import FakeLlm
from app.voice.fakes.tts import FakeTts, FakeTtsOptions
from app.voice.types import (
    LlmRequest,
    SttClosed,
    SttEvent,
    SttSpeechStarted,
    SttTranscript,
)
from app.ws.call import Providers, VoiceDeps, settle_calls
from tests.helpers.app import serve
from tests.helpers.db import TestSchema
from tests.smoke.deployed_smoke import (
    DEFAULT_LIMITS,
    CheckResult,
    Limits,
    Options,
    RunResult,
    all_passed,
    by_name,
    parse_args,
    restart_by_operator,
    run_e2e,
    speech_onset_ms,
    wav_pcm,
)

WEB_DIST = Path(__file__).resolve().parents[2] / "web" / "dist"
BASE_URL = os.environ.get("SMOKE_BASE_URL")


def _problems(results: list[CheckResult]) -> str:
    return json.dumps([r.__dict__ for r in results if r.status != "pass"])


# ---------------------------------------------------------------------------------------------------------------------
# Against a real deployment


@pytest.mark.skipif(not BASE_URL, reason="SMOKE_BASE_URL is not set (the live run uses real provider quota)")
class TestLive:
    async def test_every_check_passes_against_the_deployment(self) -> None:
        assert BASE_URL
        restart = os.environ.get("SMOKE_RESTART") == "1"
        no_db = os.environ.get("SMOKE_NO_DB") == "1"
        result = await run_e2e(
            Options(
                base=BASE_URL,
                restart=restart,
                no_db=no_db,
                database_url=os.environ.get("SMOKE_DATABASE_URL"),
                restart_service=restart_by_operator if restart else None,
            )
        )
        failed = [r for r in result.results if r.status == "fail"]
        assert not failed, _problems(result.results)
        skipped = [r for r in result.results if r.status == "skip"]
        assert no_db or not skipped, _problems(result.results)  # a skipped check makes the run incomplete


# ---------------------------------------------------------------------------------------------------------------------
# Without network: the script's pieces


class TestPieces:
    def test_parse_args(self) -> None:
        assert parse_args(["https://x.example", "--restart", "--no-db"]) == ("https://x.example", True, True)
        assert parse_args(["http://127.0.0.1:1"]) == ("http://127.0.0.1:1", False, False)
        for bad in ([], ["ftp://x"], ["not a url"], ["https://x.example", "--nope"]):
            with pytest.raises(ValueError):
                parse_args(bad)

    def test_speech_onset_is_where_the_first_loud_frame_starts(self) -> None:
        quiet = bytes(640 * 5)
        loud = struct.pack("<320h", *([3_000] * 320))
        assert speech_onset_ms(quiet + loud) == 100
        assert speech_onset_ms(quiet) == 0

    def test_wav_pcm_skips_the_header_and_refuses_a_non_wav(self) -> None:
        assert wav_pcm(b"RIFF....data\x04\x00\x00\x00abcd") == b"abcd"
        with pytest.raises(ValueError):
            wav_pcm(b"nope")

    def test_the_module_never_reads_or_prints_the_database_url_itself(self) -> None:
        source = (Path(__file__).parent / "deployed_smoke.py").read_text()
        assert not re.search(r"print\([^)]*database_url", source)


# ---------------------------------------------------------------------------------------------------------------------
# Against a local deployment-like server with fake providers


class LoudnessStt:
    """Speech start after 60 ms of loud frames, an interim at 100 ms, a final after 500 ms of quiet."""

    def __init__(self) -> None:
        self.deaf = False

    async def open(self, on_event: Any) -> Any:
        stt = self
        state = {"loud": 0, "quiet": 0, "speaking": False, "closed": False}

        def emit(event: SttEvent) -> None:
            if not state["closed"] and not stt.deaf:
                on_event(event)

        class Stream:
            def push(self, pcm: bytes) -> None:
                samples = struct.unpack(f"<{len(pcm) // 2}h", pcm)
                level = math.sqrt(sum(s * s for s in samples) / len(samples))
                if level > 1_500:
                    state["loud"] += 1
                    state["quiet"] = 0
                    if state["loud"] == 3:
                        state["speaking"] = True
                        emit(SttSpeechStarted())
                    if state["loud"] == 5:
                        emit(SttTranscript("my screen", False, False))
                elif state["speaking"]:
                    state["quiet"] += 1
                    if state["quiet"] >= 25:
                        state["speaking"] = False
                        state["loud"] = 0
                        emit(SttTranscript("my screen flickers and goes black", True, True))

            async def close(self) -> None:
                state["closed"] = True
                on_event(SttClosed())

        return Stream()


class ScriptedLlm(FakeLlm):
    """Greets, asks for the serial number card on the first answer, acknowledges chat events, otherwise talks at length."""

    def __init__(self) -> None:
        super().__init__()
        self.asked = False

    async def stream(self, request: LlmRequest) -> Any:
        from app.voice.fakes.llm import LlmScript

        messages = request.messages
        last = messages[-1] if messages else None
        state = next(
            (m for m in reversed(messages) if m.role == "system" and (m.content or "").startswith("STATE ")), None
        )
        events = json.loads((state.content or "")[6:]).get("newChatEvents", []) if state else []
        spoke = any(m.role == "user" and not (m.content or "").startswith("STATE") for m in messages)
        if events:
            self.enqueue(LlmScript(text="Thanks, I've got your serial number."))
        elif last is not None and last.role == "tool":
            self.enqueue(
                LlmScript(
                    text="Noted. While you type that, tell me how you use the phone day to day, and when exactly the"
                    " screen trouble started, please."
                )
            )
        elif spoke and not self.asked:
            self.asked = True
            self.enqueue(LlmScript(tool_calls=[{"name": "request_chat_input", "args": {"field": "serialNumber"}}]))
        elif spoke:
            self.enqueue(
                LlmScript(
                    text="I see. Please tell me a little more about how you use the phone, and whether it was dropped"
                    " or got wet at any point before this."
                )
            )
        else:
            self.enqueue(LlmScript(text="Hi, I'm Riya from device repairs. What's wrong with your device?"))
        return await super().stream(request)


@dataclass
class Deployment:
    url: str
    schema: TestSchema
    close: Any


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


async def start_deployment(schema: TestSchema, *, break_barge_in: bool = False) -> Deployment:
    port = free_port()
    origin = f"http://127.0.0.1:{port}"
    file_secret = Secret(os.urandom(32).hex())
    hook_secret = Secret(os.urandom(32).hex())
    db = await schema.open(max_size=10)
    log = create_logger("silent")
    services = create_session_services(
        pool=db.pool,
        log=log,
        sign_file_url=create_file_url_signer(secret=file_secret, public_origin=origin).sign,
    )
    stt = LoudnessStt()
    voice = VoiceDeps(
        providers=lambda: Providers(stt, FakeTts(FakeTtsOptions(clock=real_clock, chars_per_frame=2)), ScriptedLlm()),
        max_concurrent_calls=2,
        timings=CallTimings(silence_ms=120_000),
        # A system that ignores the user talking over it: the script must notice.
        barge_in=BargeInSettings(min_words=99, min_speech_ms=600_000, ignore_agent_ms=600_000)
        if break_barge_in
        else None,
    )
    app = build_app(
        log=log,
        db=db,
        web_dist_dir=WEB_DIST,
        require_web_build=True,
        public_origin=origin,
        services=services,
        file_url_secret=file_secret,
        hook_secret=hook_secret,
        uploads_per_minute=1000,
        new_sessions_per_ip_per_hour=1000,
        api_rate_limit_per_minute=1000,
        voice=voice,
    )
    running = await serve(app, port=port)
    outbox = OutboxWorker(pool=db.pool, log=log, url=Secret(f"{origin}/hooks/records"), hook_secret=hook_secret)
    services.processor.on_outbox_queued = outbox.notify
    await outbox.start()

    async def close() -> None:
        await outbox.stop()
        await running.close()
        # Like the server's shutdown: let every call finish ending before the pool closes (its EndCall must commit).
        await settle_calls(running.runtime.calls)
        await db.close()

    return Deployment(url=origin, schema=schema, close=close)


def local_options(deployment: Deployment, **overrides: Any) -> Options:
    schema = deployment.schema

    async def connect_db() -> Any:
        return await asyncpg.connect(schema.base_url, server_settings={"search_path": schema.name})

    options = Options(base=deployment.url, connect_db=connect_db, limits=DEFAULT_LIMITS)
    return replace(options, **overrides)


@pytest.mark.skipif(not (WEB_DIST / "index.html").exists(), reason="web/dist is not built (npm run build -w web)")
class TestAgainstALocalDeployment:
    async def test_passes_every_check_on_a_healthy_system_and_leaves_one_record_and_one_receiver_row(
        self, schema: TestSchema
    ) -> None:
        deployment = await start_deployment(schema)
        try:
            result: RunResult = await run_e2e(local_options(deployment))
        finally:
            await deployment.close()
        assert [r for r in result.results if r.status != "pass"] == [], _problems(result.results)
        assert len(result.results) >= 12
        assert result.summary["stopPlaybackAfterSpeechMs"] <= 1_000
        assert result.summary["acknowledgedField"] == "serialNumber"
        assert re.fullmatch(r"[0-9a-f-]{36}", result.session_id)
        uuid.UUID(result.session_id)

    async def test_fails_and_says_which_check_when_the_user_cannot_interrupt_the_agent(
        self, schema: TestSchema
    ) -> None:
        deployment = await start_deployment(schema, break_barge_in=True)
        try:
            result = await run_e2e(
                local_options(
                    deployment, no_db=True, limits=replace(DEFAULT_LIMITS, stop_playback_after_speech_ms=1_000)
                )
            )
        finally:
            await deployment.close()
        found = by_name(result.results, "barge-in")
        assert found is not None and found.status == "fail"
        assert not all_passed(result.results)

    async def test_fails_when_the_agent_audio_arrives_later_than_the_limit_and_stops_early(
        self, schema: TestSchema
    ) -> None:
        deployment = await start_deployment(schema)
        try:
            limits: Limits = replace(DEFAULT_LIMITS, agent_audio_after_connect_ms=0)
            result = await run_e2e(local_options(deployment, no_db=True, limits=limits))
        finally:
            await deployment.close()
        late = next(r for r in result.results if r.name.startswith("agent audio arrives"))
        assert late.status == "fail"
        # A failed first call check ends the run early: nothing after it is claimed.
        assert not any("barge-in" in r.name for r in result.results)

    async def test_reports_a_skipped_database_check_as_skipped_the_run_is_then_incomplete(
        self, schema: TestSchema
    ) -> None:
        deployment = await start_deployment(schema)
        try:
            result = await run_e2e(local_options(deployment, connect_db=None, database_url=None))
        finally:
            await deployment.close()
        assert [r for r in result.results if r.status == "fail"] == [], _problems(result.results)
        assert [r.detail for r in result.results if r.status == "skip"] == ["DATABASE_URL is not set"]

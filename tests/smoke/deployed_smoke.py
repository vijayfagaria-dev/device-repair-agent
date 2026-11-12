"""Deployed synthetic end-to-end run and restart verification (port of server/test/deployed/e2e.ts, P10-T05).

Runs against a PUBLIC URL with the real providers (Deepgram, Groq), like a reviewer would use the system: both sockets,
speech from a WAV streamed in real time, chat cards answered while the call is on, a barge-in, a hang-up, the rest of the
claim in chat, the record and the receiver::

    python -m tests.smoke.deployed_smoke https://<app>.onrender.com             # DATABASE_URL in the environment
    python -m tests.smoke.deployed_smoke https://<app>.onrender.com --restart   # restart the service mid-call
    ... --no-db                                                                 # skip the database checks (reported as skipped)

It uses real free-tier quota (a few minutes of Deepgram audio, about 20 Groq requests), so it is run deliberately, never
on every push. Exit 0 only if every check passed; 1 on any failed or skipped check; 2 on bad arguments.

Environment (shell only, never argv; nothing is printed, including in failure details):
  DATABASE_URL            the Neon URL: read-only checks of the receiver row, the records count and the usage ledger.
  RENDER_DEPLOY_HOOK_URL  (--restart) a deploy hook the script calls itself; without it, it waits for you to press Restart
                          in the dashboard and then Enter.

Importing this module touches no network.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import math
import os
import re
import struct
import sys
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import asyncpg
import httpx
from websockets.asyncio.client import ClientConnection
from websockets.asyncio.client import connect as ws_connect

MIC_FRAME_BYTES = 640
FRAME_MS = 20
SPEECH_WAV = Path(__file__).resolve().parent.parent / "fixtures" / "audio" / "u1.wav"
FIRST_REQUEST_TIMEOUT_S = 120.0  # a sleeping free instance takes about a minute to wake

Json = dict[str, Any]


@dataclass(frozen=True)
class Limits:
    """What the acceptance criteria require, in milliseconds."""

    agent_audio_after_connect_ms: float = 3_000
    stop_playback_after_speech_ms: float = 1_000
    handoff_after_hangup_ms: float = 1_000
    acknowledgement_ms: float = 20_000


DEFAULT_LIMITS = Limits()


@dataclass
class Options:
    base: str
    restart: bool = False
    #: None: the database checks are skipped (and reported as such, which fails the run).
    database_url: str | None = None
    no_db: bool = False
    #: `--restart`: restarts the service. Resolves when the operator (or the deploy hook) has done it.
    restart_service: Callable[[], Awaitable[None]] | None = None
    limits: Limits = DEFAULT_LIMITS
    log: Callable[[str], None] = lambda _line: None
    #: Opens the database connection (default: asyncpg on `database_url`); tests on a schema pass their own.
    connect_db: Callable[[], Awaitable[Any]] | None = None


@dataclass
class CheckResult:
    name: str
    status: str  # "pass" | "fail" | "skip"
    detail: str


@dataclass
class RunResult:
    results: list[CheckResult]
    summary: Json
    session_id: str


def by_name(results: list[CheckResult], part: str) -> CheckResult | None:
    return next((r for r in results if part in r.name), None)


def all_passed(results: list[CheckResult]) -> bool:
    return all(r.status == "pass" for r in results)


# ---------------------------------------------------------------------------------------------------------------------
# Small helpers


def now_ms() -> float:
    return time.monotonic() * 1000


async def wait_until[T](what: str, timeout_ms: float, probe: Callable[[], T | bool | None], every_ms: float = 25) -> T:
    deadline = now_ms() + timeout_ms
    while True:
        found = probe()
        if found:
            return found  # type: ignore[return-value]
        if now_ms() > deadline:
            raise TimeoutError(f"timed out after {round(timeout_ms)} ms waiting for {what}")
        await asyncio.sleep(every_ms / 1000)


@dataclass
class Received:
    at: float
    msg: Json


class Wire:
    """A WebSocket that keeps every JSON message with the time it arrived (binary frames are ignored)."""

    def __init__(self, url: str, origin: str) -> None:
        self.url = url
        self.origin = origin
        self.messages: list[Received] = []
        self.closed: tuple[float, int, str] | None = None
        #: Cards this run has sent an answer to (the server's answer bubble follows a moment later).
        self.submitted: set[str] = set()
        self.opened_at = 0.0
        self._ws: ClientConnection | None = None
        self._task: asyncio.Task[None] | None = None

    async def open(self, timeout_s: float = 20.0) -> None:
        try:
            self._ws = await ws_connect(
                self.url,
                origin=self.origin,  # type: ignore[arg-type]
                open_timeout=timeout_s,
                ping_interval=None,
                max_size=None,
                compression=None,
            )
        except Exception as err:
            raise ConnectionError(f"socket did not open ({type(err).__name__})") from None
        self.opened_at = now_ms()
        self._task = asyncio.ensure_future(self._read())

    async def _read(self) -> None:
        assert self._ws is not None
        try:
            async for data in self._ws:
                if isinstance(data, bytes):
                    continue
                with contextlib.suppress(ValueError):
                    parsed = json.loads(data)
                    if isinstance(parsed, dict):
                        self.messages.append(Received(now_ms(), parsed))
        except Exception:
            pass
        self.closed = (now_ms(), self._ws.close_code or 1006, self._ws.close_reason or "")

    def of(self, type_: str) -> list[Received]:
        return [m for m in self.messages if m.msg.get("type") == type_]

    async def send(self, message: Any) -> None:
        if self._ws is not None and self._ws.state.name == "OPEN":
            await self._ws.send(json.dumps(message) if not isinstance(message, bytes) else message)

    @property
    def is_open(self) -> bool:
        return self._ws is not None and self._ws.state.name == "OPEN"

    async def close(self, code: int = 1000) -> None:
        if self._ws is not None and self.is_open:
            with contextlib.suppress(Exception):
                await self._ws.close(code)
        if self._task is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self._task, 2)


# ---------------------------------------------------------------------------------------------------------------------
# Audio: 20 ms frames of the speech fixture, sent in real time


def wav_pcm(wav: bytes) -> bytes:
    at = wav.find(b"data")
    if at < 0:
        raise ValueError("not a WAV file")
    return wav[at + 8 :]


def _rms(pcm: bytes) -> float:
    samples = struct.unpack(f"<{len(pcm) // 2}h", pcm[: len(pcm) // 2 * 2])
    return math.sqrt(sum(s * s for s in samples) / len(samples))


def speech_onset_ms(pcm: bytes) -> float:
    """The offset (ms) of the first frame that is clearly speech: where the user's speech "starts" for latency purposes."""
    for i in range(0, len(pcm) - MIC_FRAME_BYTES + 1, MIC_FRAME_BYTES):
        if _rms(pcm[i : i + MIC_FRAME_BYTES]) > 1_500:
            return i // MIC_FRAME_BYTES * FRAME_MS
    return 0


def load_speech() -> bytes:
    return wav_pcm(SPEECH_WAV.read_bytes())


@dataclass
class Speaking:
    #: The clock time (ms) the first loud frame leaves.
    onset_at: float
    done: Callable[[], Awaitable[None]]


class Mic:
    def __init__(self, wire: Wire, speech: bytes) -> None:
        self._wire = wire
        self._speech = speech
        self._running = False
        self._queue: list[bytes] = []
        self._task: asyncio.Task[None] | None = None
        self.frames_sent = 0

    def start(self) -> None:
        """Streams silence, and any queued speech, one frame every 20 ms until stopped. A mic never goes quiet."""
        self._running = True
        self._task = asyncio.ensure_future(self._tick())

    async def _tick(self) -> None:
        silence = bytes(MIC_FRAME_BYTES)
        nxt = now_ms()
        while self._running:
            frame = self._queue.pop(0) if self._queue else silence
            if self._wire.is_open:
                await self._wire.send(frame)
                self.frames_sent += 1
            nxt += FRAME_MS
            await asyncio.sleep(max(0.0, (nxt - now_ms()) / 1000))

    def speak(self, pcm: bytes | None = None, trailing_silence_ms: float = 1_500) -> Speaking:
        """Queues `pcm` and trailing silence; `done()` resolves once every queued frame has been sent."""
        pcm = self._speech if pcm is None else pcm
        frames = [pcm[i : i + MIC_FRAME_BYTES] for i in range(0, len(pcm) - MIC_FRAME_BYTES + 1, MIC_FRAME_BYTES)]
        frames += [bytes(MIC_FRAME_BYTES)] * int(trailing_silence_ms / FRAME_MS)
        onset_at = now_ms() + (len(self._queue) + speech_onset_ms(pcm) / FRAME_MS) * FRAME_MS
        self._queue.extend(frames)

        async def done() -> None:
            while self._queue and self._running:  # noqa: ASYNC110 (a 20 ms poll of the mic's own frame queue)
                await asyncio.sleep(FRAME_MS / 1000)

        return Speaking(onset_at, done)

    async def stop(self) -> None:
        self._running = False
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task


def audio_seconds(wire: Wire) -> float:
    """Seconds of audio received so far (each message is PCM16 mono at its own sample rate)."""
    return sum(
        len(base64.b64decode(str(m.msg.get("data", "")))) / 2 / float(m.msg.get("sampleRate") or 24_000)
        for m in wire.of("audio")
    )


# ---------------------------------------------------------------------------------------------------------------------
# The chat side: answering whichever card is open the way a user would

PDF = b"%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n"
TEXT_ANSWERS: dict[str, str] = {
    "deviceModel": "Samsung Galaxy S23",
    "problemDescription": "The screen flickers and then goes black after a minute",
    "serialNumber": "352099001761481",
    "email": "asha.rao@example.com",
    "additionalNotes": "",
}

#: Cards that name the field the agent can acknowledge by words.
ACKNOWLEDGES: dict[str, re.Pattern[str]] = {
    "serialNumber": re.compile(r"serial|imei", re.I),
    "email": re.compile(r"e-?mail", re.I),
    "purchaseInvoice": re.compile(r"invoice|receipt|purchase|upload", re.I),
    "deviceModel": re.compile(r"model|galaxy|samsung|brand", re.I),
    "problemStartedAt": re.compile(r"when|start|began|days?", re.I),
    "deviceType": re.compile(r"phone|device|laptop|tablet|watch", re.I),
    "urgency": re.compile(r"urgen|soon|quick", re.I),
    "serviceCentre": re.compile(r"service|cent(er|re)", re.I),
}
GENERIC_ACK = re.compile(r"thanks|thank you|got it|received", re.I)


def five_days_ago() -> str:
    return (datetime.now(UTC) - timedelta(days=5)).date().isoformat()


def open_cards(chat: Wire) -> list[Json]:
    """Every card the server has sent that hasn't been answered or cancelled yet."""
    answered = {str(m.msg.get("requestId") or "") for m in chat.of("message")}
    cancelled = {str(m.msg.get("requestId")) for m in chat.of("inputCancel")}
    # A card paused by Stop and resumed reuses its id: a later inputRequest with the same id is the same card.
    cards: dict[str, Json] = {}
    for m in chat.of("inputRequest"):
        cards[str(m.msg.get("id"))] = m.msg
    return [c for c in cards.values() if c["id"] not in answered | cancelled | chat.submitted]


async def upload(http: httpx.AsyncClient, session_id: str, name: str, data: bytes) -> str:
    response = await http.post(f"/sessions/{session_id}/files", files={"file": (name, data, "application/pdf")})
    if not response.is_success:
        raise RuntimeError(f"upload refused: HTTP {response.status_code}")
    url = response.json().get("url")
    if not isinstance(url, str):
        raise RuntimeError("upload gave no url")
    return url


async def answer_for(card: Json, http: httpx.AsyncClient, session_id: str) -> Any:
    """The answer a user would give this card, or raises if the card is one the script doesn't know."""
    kind = card.get("kind")
    if kind == "select":
        options = card.get("options") or []
        return options[0]["value"] if options else None
    if kind == "confirm":
        return True
    if kind == "date":
        return five_days_ago()
    if kind == "file":
        if card.get("field") == "additionalPhotos":
            return None  # optional: skip
        url = await upload(http, session_id, "invoice.pdf", PDF)
        return [url] if card.get("multiple") else url
    text = TEXT_ANSWERS.get(str(card.get("field")))
    if text is None:
        raise RuntimeError(f'no scripted answer for the card "{card.get("label")}" ({card.get("field")})')
    return None if text == "" else text


async def answer_card(chat: Wire, card: Json, http: httpx.AsyncClient, session_id: str) -> float:
    value = await answer_for(card, http, session_id)
    chat.submitted.add(card["id"])
    at = now_ms()
    await chat.send({"type": "inputResponse", "requestId": card["id"], "field": card["field"], "value": value})
    return at


# ---------------------------------------------------------------------------------------------------------------------
# The run

LEAK_RULES: list[tuple[str, re.Pattern[str]]] = [
    ("groq key", re.compile(r"gsk_[A-Za-z0-9]{20,}")),
    ("google api key", re.compile(r"AIza[0-9A-Za-z_-]{30,}")),
    ("openai-style key", re.compile(r"sk-[A-Za-z0-9_-]{20,}")),
    ("bearer token", re.compile(r"[Bb]earer [A-Za-z0-9._~+/=-]{20,}")),
    ("database url", re.compile(r"postgres(ql)?://[^\"' ]+@")),
    ("private key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    (
        "server secret name",
        re.compile(
            "(DEEPGRAM_API_KEY|GROQ_API_KEY|GEMINI_API_KEY|DATABASE_URL|FILE_URL_SECRET|HOOK_SECRET|TEST_API_TOKEN"
            "|QUOTA_OVERRIDE_TOKEN)"
        ),
    ),
    ("hook secret header", re.compile(r"[Xx]-[Hh]ook-[Ss]ecret", re.I)),
]


@dataclass
class _Run:
    options: Options
    http: httpx.AsyncClient
    ws_base: str
    origin: str
    session_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    results: list[CheckResult] = field(default_factory=list)
    summary: Json = field(default_factory=dict)

    @property
    def log(self) -> Callable[[str], None]:
        return self.options.log

    async def check(self, name: str, fn: Callable[[], Awaitable[Any]]) -> bool:
        try:
            returned = await fn()
        except Exception as err:
            detail = str(err) or type(err).__name__
            self.results.append(CheckResult(name, "fail", detail))
            self.log(f"FAIL  {name}: {detail}")
            return False
        detail = returned if isinstance(returned, str) else ""
        self.results.append(CheckResult(name, "pass", detail))
        self.log(f"PASS  {name}{f' ({detail})' if detail else ''}")
        return True

    def skip(self, name: str, why: str) -> None:
        self.results.append(CheckResult(name, "skip", why))
        self.log(f"SKIP  {name}: {why}")

    async def fetch_text(self, path: str, timeout_s: float = 20.0) -> tuple[httpx.Response, str]:
        response = await self.http.get(path, headers={"origin": self.origin}, timeout=timeout_s)
        return response, response.text


async def run_e2e(options: Options) -> RunResult:
    base = urlsplit(options.base)
    origin = f"{base.scheme}://{base.netloc}"
    ws_base = ("wss" if base.scheme == "https" else "ws") + f"://{base.netloc}"
    speech = load_speech()
    async with httpx.AsyncClient(base_url=origin, follow_redirects=False) as http:
        run = _Run(options, http, ws_base, origin)
        return await _run(run, speech)


async def _run(run: _Run, speech: bytes) -> RunResult:
    options, limits, origin, session_id = run.options, run.options.limits, run.origin, run.session_id
    http, summary, check = run.http, run.summary, run.check
    done = RunResult(run.results, summary, session_id)

    # 1. The service is up, and what the browser downloads is clean. ---------------------------------------------------
    async def service_up() -> str:
        started = now_ms()
        while True:
            try:
                response, _ = await run.fetch_text("/healthz", 15)
                if response.status_code == 200:
                    return f"{round(now_ms() - started)} ms"
            except httpx.HTTPError:
                pass  # still waking
            if now_ms() - started > FIRST_REQUEST_TIMEOUT_S * 1000:
                raise RuntimeError("no 200 from /healthz within 120 s")
            await asyncio.sleep(2)

    async def security_headers() -> None:
        response, _ = await run.fetch_text("/")
        need = ["content-security-policy", "referrer-policy", "permissions-policy", "x-content-type-options"]
        # HSTS is only sent (and only means something) over https; a local http run has none.
        if origin.startswith("https:"):
            need.append("strict-transport-security")
        missing = [h for h in need if not response.headers.get(h)]
        if missing:
            raise RuntimeError(f"missing: {', '.join(missing)}")
        if "microphone=(self)" not in response.headers.get("permissions-policy", ""):
            raise RuntimeError("permissions-policy lacks microphone=(self)")
        if "unsafe-" in response.headers.get("content-security-policy", ""):
            raise RuntimeError("CSP allows unsafe-*")

    async def bundle_has_no_secret() -> str:
        _, html = await run.fetch_text("/")
        assets = re.findall(r'(?:src|href)="(/assets/[^"]+)"', html)
        if not assets:
            raise RuntimeError("the page references no assets")
        leaks: list[str] = []
        for asset in [*assets, "/"]:
            _, text = await run.fetch_text(asset)
            leaks += [f"{name} in {asset}" for name, pattern in LEAK_RULES if pattern.search(text)]  # never the match
        if leaks:
            raise RuntimeError("; ".join(leaks))
        return f"{len(assets)} assets scanned"

    await check("service is up (/healthz, waiting for a sleeping instance to wake)", service_up)
    await check("security headers on the page", security_headers)
    await check("the deployed web bundle contains no secret", bundle_has_no_secret)

    # 2. The call. ---------------------------------------------------------------------------------------------------
    chat = Wire(f"{run.ws_base}/chat?sessionId={session_id}", origin)
    await chat.open()
    await wait_until("the chat replay (syncDone)", 20_000, lambda: chat.of("syncDone"))
    call = Wire(f"{run.ws_base}/call?sessionId={session_id}", origin)
    mic = Mic(call, speech)
    call_ok = False

    async def first_audio() -> str:
        nonlocal call_ok
        await call.open()
        mic.start()
        first = await wait_until("the greeting's first audio", 15_000, lambda: call.of("audio")[:1])
        ms = round(first[0].at - call.opened_at)
        summary["firstAudioAfterConnectMs"] = ms
        if ms > limits.agent_audio_after_connect_ms:
            raise RuntimeError(f"{ms} ms")
        call_ok = True
        return f"{ms} ms"

    await check(
        f"agent audio arrives within {round(limits.agent_audio_after_connect_ms)} ms of connecting the call",
        first_audio,
    )
    if not call_ok:
        await mic.stop()
        await call.close()
        await chat.close()
        return done

    def agent_lines() -> list[Received]:
        return [m for m in call.of("transcript") if m.msg.get("role") == "agent" and m.msg.get("final") is True]

    def user_lines() -> list[Received]:
        return [m for m in call.of("transcript") if m.msg.get("role") == "user" and m.msg.get("final") is True]

    async def greeting_line() -> str:
        line = await wait_until("the greeting transcript", 15_000, lambda: agent_lines()[:1])
        return f'"{str(line[0].msg.get("text"))[:60]}"'

    await check("the greeting is a transcript line from the agent", greeting_line)
    # The greeting plays in real time: speak after it has finished, as a person would.
    first_at = call.of("audio")[0].at if call.of("audio") else now_ms()
    greeting_end = first_at + audio_seconds(call) * 1000
    await asyncio.sleep(max(0.0, greeting_end - now_ms()) / 1000 + 0.4)

    async def speech_answered() -> str:
        before = len(agent_lines())
        audio_before = len(call.of("audio"))
        spoke = mic.speak()
        speech_end = spoke.onset_at + (len(speech) / MIC_FRAME_BYTES * FRAME_MS - speech_onset_ms(speech))
        await wait_until("the user's final transcript", 20_000, lambda: user_lines()[:1])
        await spoke.done()
        await wait_until(
            "the agent's answer", 30_000, lambda: len(agent_lines()) > before and len(call.of("audio")) > audio_before
        )
        answer_audio = next(
            (m for i, m in enumerate(call.of("audio")) if i >= audio_before and m.at > speech_end - 500), None
        )
        if answer_audio:
            summary["speechEndToFirstAnswerAudioMs"] = round(answer_audio.at - speech_end)
        return f'heard "{str(user_lines()[0].msg.get("text"))[:50]}"'

    await check("the user's speech is transcribed and the agent answers in speech", speech_answered)

    # 3. A card answered in chat while the call is on, acknowledged by the agent. -----------------------------------
    acknowledged: list[str] = []

    async def acknowledged_in_call() -> str:
        # The agent asks for typed values with request_chat_input; give it two turns to do so.
        cards = open_cards(chat)
        card = cards[0] if cards else None
        turn = 0
        while card is None and turn < 2:
            spoke = mic.speak()
            with contextlib.suppress(TimeoutError):
                card = await wait_until(
                    "a card to open in chat during the call", 30_000, lambda: (open_cards(chat) or [None])[0]
                )
            await spoke.done()
            turn += 1
        if card is None:
            raise RuntimeError("no card opened in chat while the call was on")
        # Never while the user is speaking: the mic is quiet now; wait for the agent to finish its own line.
        await asyncio.sleep(0.5)
        agent_before = len(agent_lines())
        submitted_at = await answer_card(chat, card, http, session_id)
        acknowledged.append(card["field"])
        pattern = ACKNOWLEDGES.get(card["field"], GENERIC_ACK)
        line = await wait_until(
            f"the agent to mention the {card['field']} you submitted",
            limits.acknowledgement_ms,
            lambda: next(
                (
                    m
                    for m in agent_lines()[agent_before:]
                    if m.at > submitted_at and pattern.search(str(m.msg.get("text")))
                ),
                None,
            ),
            50,
        )
        return f"{card['field']} acknowledged {round(line.at - submitted_at)} ms after submitting"

    await check(
        f"a chat submission during the call is acknowledged by the agent within {round(limits.acknowledgement_ms)} ms",
        acknowledged_in_call,
    )

    # 4. The restart variant pauses here, with the call live and a session part-way through. -------------------------
    if options.restart:
        return await _restart_and_finish(run, chat, call, mic)

    # 5. Barge-in. -----------------------------------------------------------------------------------------------------
    async def barge_in() -> str:
        # Make the agent talk (it answers whatever we say), then talk over it.
        audio_before = len(call.of("audio"))
        await mic.speak(speech, 300).done()
        await wait_until("the agent to start speaking", 30_000, lambda: len(call.of("audio")) > audio_before)
        await asyncio.sleep(0.5)  # past the barge-in confirmation window, mid-sentence
        stops_before = len(call.of("stopPlayback"))
        interruption = mic.speak(speech, 1_500)
        stop = await wait_until("stopPlayback", 10_000, lambda: call.of("stopPlayback")[stops_before:][:1])
        ms = round(stop[0].at - interruption.onset_at)
        summary["stopPlaybackAfterSpeechMs"] = ms
        if ms > limits.stop_playback_after_speech_ms:
            raise RuntimeError(f"{ms} ms (limit {round(limits.stop_playback_after_speech_ms)})")
        await wait_until(
            "the interrupted agent line",
            15_000,
            lambda: next((m for m in agent_lines() if str(m.msg.get("text")).endswith("[interrupted]")), None),
        )
        await interruption.done()
        return f"{ms} ms"

    await check(
        f"barge-in: stopPlayback within {round(limits.stop_playback_after_speech_ms)} ms of the injected speech and the agent line is truncated",
        barge_in,
    )

    # 6. Hang up; the chat takes over. ---------------------------------------------------------------------------------
    async def hand_off() -> str:
        # Let the interrupting utterance finish and the agent settle.
        await asyncio.sleep(2)
        seen = len(chat.messages)
        hung_up_at = now_ms()
        await mic.stop()
        await call.close(1000)
        nxt = await wait_until(
            "a chat message after the hang-up",
            10_000,
            lambda: next((m for m in chat.messages[seen:] if m.msg.get("type") in ("message", "inputRequest")), None),
        )
        ms = round(nxt.at - hung_up_at)
        summary["handoffAfterHangupMs"] = ms
        await wait_until("a card to be open", 10_000, lambda: open_cards(chat)[:1])
        if ms > limits.handoff_after_hangup_ms:
            raise RuntimeError(f"{ms} ms (limit {round(limits.handoff_after_hangup_ms)})")
        return f"{ms} ms"

    await check(
        f"after hang-up the chat continues within {round(limits.handoff_after_hangup_ms)} ms (the next message or card)",
        hand_off,
    )

    # 7. The rest of the claim in chat; the record. ---------------------------------------------------------------------
    record = await _finish_in_chat(run, chat, "complete the claim in chat and receive the record")
    await _verify_record(run, record)
    await _verify_database(run, 1)
    await chat.close()
    await call.close()
    summary["acknowledgedField"] = acknowledged[0] if acknowledged else None
    return done


async def _finish_in_chat(run: _Run, wire: Wire, name: str) -> Json | None:
    record: Json | None = None

    async def finish() -> str:
        nonlocal record
        answered = 0
        for _ in range(24):
            if record:
                break
            found = await wait_until(
                "a card or the record", 20_000, lambda: wire.of("record")[:1] or open_cards(wire)[:1]
            )
            first = found[0]
            if isinstance(first, Received):
                record = first.msg["record"]
                break
            card = first
            await answer_card(wire, card, run.http, run.session_id)
            answered += 1
            # Taken (an answer bubble for this card) or refused (an inputError), or the claim is already done.
            await wait_until(
                "the server to take the answer",
                20_000,
                lambda card_id=card["id"]: (
                    wire.of("record")
                    or [m for m in wire.of("inputError") if m.msg.get("requestId") == card_id]
                    or [m for m in wire.of("message") if m.msg.get("requestId") == card_id]
                ),
            )
            rejected = next((m for m in wire.of("inputError") if m.msg.get("requestId") == card["id"]), None)
            if rejected:
                raise RuntimeError(
                    f'the server refused the answer to "{card.get("label")}": {rejected.msg.get("message")}'
                )
        if not record:
            raise RuntimeError("the claim did not reach a record")
        return f"{answered} cards answered in chat"

    await run.check(name, finish)
    return record


async def _verify_record(run: _Run, record: Json | None) -> None:
    session_id = run.session_id

    async def record_complete() -> str:
        if not record:
            raise RuntimeError("no record")
        if record.get("sessionId") != session_id:
            raise RuntimeError("wrong sessionId")
        if record.get("outcome") != "completed":
            raise RuntimeError(f"outcome {record.get('outcome')} ({record.get('outcomeReason')})")
        if record.get("revision") != 1:
            raise RuntimeError(f"revision {record.get('revision')}")
        fields: dict[str, Json] = record.get("fields") or {}
        bad = [
            (name, f)
            for name, f in fields.items()
            if f.get("status") != "valid" and name not in ("additionalPhotos", "additionalNotes")
        ]
        if bad:
            raise RuntimeError(f"not valid: {', '.join(f'{n}={f.get("status")}' for n, f in bad)}")
        engagement = record.get("engagement") or {}
        if (engagement.get("calls") or 0) < 1:
            raise RuntimeError("the record shows no call")
        sources = sorted({f["source"] for f in fields.values() if f.get("source")})
        return f"sources: {'+'.join(sources)}"

    async def invoice_downloads() -> None:
        invoice = (((record or {}).get("fields") or {}).get("purchaseInvoice") or {}).get("value") or {}
        url = invoice.get("url")
        if not url:
            raise RuntimeError("no signed URL in the record")
        response = await run.http.get(url)
        if response.status_code != 200:
            raise RuntimeError(f"HTTP {response.status_code}")
        forged = await run.http.get(f"{url}x")
        if forged.status_code == 200:
            raise RuntimeError("a tampered link was accepted")

    async def reads_back_finalized() -> None:
        response, text = await run.fetch_text(f"/api/sessions/{session_id}")
        if response.status_code != 200:
            raise RuntimeError(f"HTTP {response.status_code}")
        body = json.loads(text)
        if body.get("status") != "finalized" or body.get("outcome") != "completed":
            raise RuntimeError(f"status {body.get('status')}, outcome {body.get('outcome')}")

    await run.check(
        "the record is completed, revision 1, for this session, with every required field valid", record_complete
    )
    await run.check("the invoice in the record downloads through its signed link", invoice_downloads)
    await run.check("the session reads back as finalized and completed over HTTP", reads_back_finalized)


async def _verify_database(run: _Run, expected_revisions: int) -> None:
    options, session_id = run.options, run.session_id
    name = "the receiver holds exactly one row for revision 1 and the session has one record (database)"
    if options.no_db or not (options.database_url or options.connect_db):
        return run.skip(name, "--no-db" if options.no_db else "DATABASE_URL is not set")

    async def verify() -> str:
        if options.connect_db is not None:
            conn = await options.connect_db()
        else:
            conn = await asyncpg.connect(options.database_url, timeout=15, command_timeout=15)
        try:
            # The outbox delivers after the commit: give it a moment.
            deadline = now_ms() + 30_000
            while True:
                row = await conn.fetchrow(
                    "SELECT times_received FROM received_records WHERE idempotency_key = $1", f"{session_id}:1"
                )
                if row:
                    break
                if now_ms() > deadline:
                    raise TimeoutError("timed out waiting for the receiver row")
                await asyncio.sleep(0.5)
            records = await conn.fetchval("SELECT count(*)::int FROM records WHERE session_id = $1", session_id)
            received = await conn.fetchval(
                "SELECT count(*)::int FROM received_records WHERE idempotency_key LIKE $1", f"{session_id}:%"
            )
            if records != expected_revisions:
                raise RuntimeError(f"{records} records for the session")
            if received != expected_revisions:
                raise RuntimeError(f"{received} receiver rows for the session")
            usage = await conn.fetch(
                "SELECT provider, kind, sum(units)::float AS units, sum(cost_usd)::float AS cost FROM usage"
                " WHERE session_id = $1 GROUP BY provider, kind ORDER BY provider, kind",
                session_id,
            )
            run.summary["timesReceived"] = row["times_received"]
            run.summary["usage"] = [f"{r['provider']}:{r['kind']}={float(r['units']):.1f}" for r in usage]
            run.summary["listPriceCostUsd"] = round(sum(float(r["cost"] or 0) for r in usage), 6)
            return f"delivered {row['times_received']}x, stored once"
        finally:
            with contextlib.suppress(Exception):
                await conn.close()

    await run.check(name, verify)


async def _restart_and_finish(run: _Run, chat: Wire, call: Wire, mic: Mic) -> RunResult:
    options, origin = run.options, run.origin
    before = len([m for m in chat.messages if m.msg.get("type") in ("message", "transcript")])

    async def restarted() -> str:
        run.log("restarting the service now (call live, one card answered)...")
        if options.restart_service is None:
            raise RuntimeError("no way to restart the service was given")
        await options.restart_service()
        # The sockets drop (1012 on a graceful shutdown, 1006 if it was cut), and the service comes back healthy.
        await wait_until("the call socket to close", 60_000, lambda: call.closed, 100)
        await mic.stop()
        await wait_until("the chat socket to close", 30_000, lambda: chat.closed, 100)
        closed_at = now_ms()
        while True:
            try:
                response, _ = await run.fetch_text("/readyz", 10)
                if response.status_code == 200:
                    break
            except httpx.HTTPError:
                pass  # not back yet
            if now_ms() - closed_at > 240_000:
                raise RuntimeError("the service did not come back within 240 s")
            await asyncio.sleep(2)
        run.summary["backAfterMs"] = round(now_ms() - closed_at)
        return f"call closed with {call.closed[1] if call.closed else None}, back after {run.summary['backAfterMs']} ms"

    await run.check("restart: the service restarts while the call is live", restarted)
    again = Wire(f"{run.ws_base}/chat?sessionId={run.session_id}", origin)

    async def resumed() -> str:
        await again.open()
        await wait_until("the replay", 30_000, lambda: again.of("syncDone"))
        replayed = len([m for m in again.messages if m.msg.get("type") in ("message", "transcript")])
        if replayed < before:
            raise RuntimeError(f"only {replayed} of {before} earlier messages came back")
        if not any(m.msg.get("role") == "agent" for m in again.of("transcript")):
            raise RuntimeError("the call's transcript is gone")
        states = again.of("sessionState")
        state = states[-1].msg if states else {}
        if state.get("status") != "active" or state.get("callActive") is not False:
            raise RuntimeError(f"state {json.dumps(state)}")
        return f"{replayed} messages replayed"

    await run.check(
        "restart: the session is resumed in chat, with what was said and answered before, and the call is over", resumed
    )
    record = await _finish_in_chat(run, again, "restart: the claim completes in chat after the restart")
    await _verify_record(run, record)
    await _verify_database(run, 1)
    await again.close()
    return RunResult(run.results, run.summary, run.session_id)


# ---------------------------------------------------------------------------------------------------------------------
# Command line


async def restart_by_operator() -> None:
    hook = os.environ.get("RENDER_DEPLOY_HOOK_URL")
    if hook:
        async with httpx.AsyncClient(timeout=30) as client:
            try:
                response = await client.post(hook)
            except httpx.HTTPError as err:
                raise RuntimeError(f"the deploy hook call failed ({type(err).__name__})") from None  # never the URL
        if not response.is_success:
            raise RuntimeError(f"the deploy hook answered HTTP {response.status_code}")
        return
    await asyncio.to_thread(
        input, "Press Restart (or Manual Deploy) in the Render dashboard now, then press Enter here... "
    )


def parse_args(argv: list[str]) -> tuple[str, bool, bool]:
    if not argv:
        raise ValueError("usage: python -m tests.smoke.deployed_smoke <base-url> [--restart] [--no-db]")
    url, *rest = argv
    if urlsplit(url).scheme not in ("http", "https") or not urlsplit(url).netloc:
        raise ValueError("base URL must be http(s)")
    restart = no_db = False
    for arg in rest:
        if arg == "--restart":
            restart = True
        elif arg == "--no-db":
            no_db = True
        else:
            raise ValueError(f"unknown argument: {arg}")
    return url, restart, no_db


async def main(argv: list[str]) -> int:
    try:
        url, restart, no_db = parse_args(argv)
    except ValueError as err:
        print(err, file=sys.stderr)
        return 2
    result = await run_e2e(
        Options(
            base=url,
            restart=restart,
            no_db=no_db,
            database_url=os.environ.get("DATABASE_URL"),
            restart_service=restart_by_operator,
            log=print,
        )
    )
    failed = [r for r in result.results if r.status == "fail"]
    skipped = [r for r in result.results if r.status == "skip"]
    print(f"\nsession {result.session_id}")
    print(json.dumps(result.summary, indent=2))
    print(f"\n{len(result.results) - len(failed) - len(skipped)} passed, {len(failed)} failed, {len(skipped)} skipped")
    if skipped:
        print("SKIPPED checks are part of the acceptance: the run is INCOMPLETE.")
    return 1 if failed or skipped else 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main(sys.argv[1:])))
    except Exception as err:
        print(f"e2e crashed: {type(err).__name__}: {err}", file=sys.stderr)
        sys.exit(1)

"""Deepgram streaming STT adapter (P5-T03, D04).

One WebSocket per call to ``listen``, with the options measured in P0-T03 (nova-3-general, linear16 16 kHz, interim
results, endpointing 150 ms, utterance_end_ms 1000, VAD events). It only translates Deepgram's messages into SttEvents;
utterances and turn ends are ``voice/user_turns.py``'s.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Callable
from typing import Any
from urllib.parse import urlencode

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosedError

from app.voice._ws import Outbox, is_closed, is_open, terminate
from app.voice.types import (
    SttClosed,
    SttError,
    SttEvent,
    SttProvider,
    SttSpeechStarted,
    SttStream,
    SttTranscript,
    SttUtteranceEnd,
)

DEEPGRAM_LISTEN_URL = "wss://api.deepgram.com/v1/listen"

#: Nova-3 keyterm prompting: the words a repair call is about, so "Riya" is not heard as "Reuters" and "cracked" as "correct".
KEYTERMS = (
    "Riya",
    "smartphone",
    "laptop",
    "tablet",
    "smartwatch",
    "headphones",
    "iPhone",
    "Samsung Galaxy",
    "OnePlus",
    "Redmi",
    "Realme",
    "MacBook",
    "Dell XPS",
    "cracked",
    "screen",
    "touch",
    "battery",
    "charging",
    "IMEI",
    "serial number",
)


def deepgram_listen_url(base: str, endpointing_ms: int) -> str:
    params: list[tuple[str, str]] = [
        ("model", "nova-3-general"),
        ("language", "en"),
        ("encoding", "linear16"),
        ("sample_rate", "16000"),
        ("channels", "1"),
        ("interim_results", "true"),
        ("endpointing", str(endpointing_ms)),
        ("utterance_end_ms", "1000"),
        ("vad_events", "true"),
        ("smart_format", "true"),
        ("punctuate", "true"),
    ]
    params.extend(("keyterm", term) for term in KEYTERMS)
    return f"{base}?{urlencode(params)}"


def to_stt_event(message: Any) -> SttEvent | None:
    """One Deepgram message -> the event it means, or None (Metadata and anything unknown)."""
    if not isinstance(message, dict):
        return None
    kind = message.get("type")
    if kind == "SpeechStarted":
        return SttSpeechStarted()
    if kind == "UtteranceEnd":
        return SttUtteranceEnd()
    if kind == "Results":
        channel = message.get("channel")
        alternatives = channel.get("alternatives") if isinstance(channel, dict) else None
        first = alternatives[0] if isinstance(alternatives, list) and alternatives else None
        text = first.get("transcript") if isinstance(first, dict) else None
        return SttTranscript(
            text=text if isinstance(text, str) else "",
            is_final=message.get("is_final") is True,
            speech_final=message.get("speech_final") is True,
        )
    return None


class _DeepgramSttStream:
    def __init__(self, ws: Any, on_event: Callable[[SttEvent], None], keep_alive_ms: float) -> None:
        self._ws = ws
        self._on_event = on_event
        self._keep_alive_ms = keep_alive_ms
        self._closed_emitted = False
        self._outbox = Outbox(ws)
        self._last_sent = time.monotonic() * 1000
        loop = asyncio.get_running_loop()
        self._reader = loop.create_task(self._read())
        self._keep_alive = loop.create_task(self._keep_alive_loop())

    async def _keep_alive_loop(self) -> None:
        # Deepgram closes a stream after ~10 s without data; a KeepAlive goes out after this long without audio.
        while True:
            await asyncio.sleep(1)
            if is_open(self._ws) and time.monotonic() * 1000 - self._last_sent >= self._keep_alive_ms:
                self._outbox.put(json.dumps({"type": "KeepAlive"}))
                self._last_sent = time.monotonic() * 1000

    async def _read(self) -> None:
        try:
            async for data in self._ws:
                if isinstance(data, bytes):
                    continue
                try:
                    parsed = json.loads(data)
                except ValueError:
                    continue
                event = to_stt_event(parsed)
                if event is not None:
                    self._on_event(event)
        except ConnectionClosedError as error:
            self._on_event(SttError(error))
        except Exception as error:
            self._on_event(SttError(error))
        finally:
            self._keep_alive.cancel()
            self._outbox.stop()
            if not self._closed_emitted:
                self._closed_emitted = True
                self._on_event(SttClosed())

    def push(self, pcm: bytes) -> None:
        if not is_open(self._ws):
            return
        self._outbox.put(bytes(pcm))
        self._last_sent = time.monotonic() * 1000

    async def close(self) -> None:
        if is_closed(self._ws):
            await asyncio.gather(self._reader, return_exceptions=True)
            return
        if is_open(self._ws):
            self._outbox.put(json.dumps({"type": "CloseStream"}))
            await self._outbox.drain(2.0)
            try:
                await asyncio.wait_for(asyncio.shield(self._reader), 2.0)
            except TimeoutError:
                terminate(self._ws)
        else:
            terminate(self._ws)
        await asyncio.gather(self._reader, return_exceptions=True)


class DeepgramStt:
    def __init__(
        self,
        *,
        api_key: Any,
        url: str | None = None,
        endpointing_ms: int = 150,
        keep_alive_ms: float = 8_000,
        connect_timeout_ms: float = 5_000,
    ) -> None:
        self._api_key = api_key
        self._url = deepgram_listen_url(url or DEEPGRAM_LISTEN_URL, endpointing_ms)
        self._keep_alive_ms = keep_alive_ms
        self._connect_timeout_ms = connect_timeout_ms

    async def open(self, on_event: Callable[[SttEvent], None]) -> SttStream:
        try:
            ws = await connect(
                self._url,
                additional_headers={"Authorization": f"Token {self._api_key.reveal()}"},
                open_timeout=self._connect_timeout_ms / 1000,
                ping_interval=None,
                compression=None,
            )
        except TimeoutError as error:
            raise TimeoutError("Deepgram STT connect timed out") from error
        return _DeepgramSttStream(ws, on_event, self._keep_alive_ms)


def create_deepgram_stt(
    *,
    api_key: Any,
    url: str | None = None,
    endpointing_ms: int = 150,
    keep_alive_ms: float = 8_000,
    connect_timeout_ms: float = 5_000,
) -> SttProvider:
    return DeepgramStt(
        api_key=api_key,
        url=url,
        endpointing_ms=endpointing_ms,
        keep_alive_ms=keep_alive_ms,
        connect_timeout_ms=connect_timeout_ms,
    )


__all__ = [
    "DEEPGRAM_LISTEN_URL",
    "KEYTERMS",
    "DeepgramStt",
    "create_deepgram_stt",
    "deepgram_listen_url",
    "to_stt_event",
]

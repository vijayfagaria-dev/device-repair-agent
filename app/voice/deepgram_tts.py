"""Deepgram Aura-2 streaming TTS adapter (P5-T04, D05).

One WebSocket per call to ``speak`` (linear16, 24 kHz), opened at call start. Per chunk: ``Speak`` then ``Flush``;
Deepgram answers with audio frames, then ``Flushed``.

Barge-in (P0-T03): ``Clear`` does not stop audio quickly (1.1-2.2 s still arrived after it), so ``cancel()`` stops
emitting the turn's audio at once and drops every frame until ``Cleared``; speech for a later turn waits for it. If
``Cleared`` doesn't come within 1 s, the socket is closed and a new one opened. A socket that drops mid-chunk is
reopened once and the unfinished chunks are sent again (failure matrix: retry a chunk once).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote

from websockets.asyncio.client import connect

from app.voice._ws import Outbox, is_open, spawn, terminate
from app.voice.types import TtsAudio, TtsClosed, TtsError, TtsEvent, TtsFlushed, TtsProvider, TtsStream

DEEPGRAM_SPEAK_URL = "wss://api.deepgram.com/v1/speak"
TTS_SAMPLE_RATE = 24_000


def deepgram_speak_url(base: str, voice: str) -> str:
    return f"{base}?model={quote(voice, safe='')}&encoding=linear16&sample_rate={TTS_SAMPLE_RATE}"


@dataclass(slots=True)
class _Segment:
    """A flushed chunk in flight: its turn and text (kept to resend once if the socket drops)."""

    turn_id: str
    text: str


@dataclass(slots=True)
class _Clearing:
    """While a Clear is outstanding: frames are dropped and new speech waits here."""

    timer: asyncio.TimerHandle | None = None
    waiting: list[Callable[[], None]] = field(default_factory=list)
    reopening: bool = False


class _Socket:
    def __init__(self, ws: Any) -> None:
        self.ws = ws
        self.outbox = Outbox(ws)
        self.reader: asyncio.Task[Any] | None = None


class DeepgramTtsStream:
    def __init__(self, provider: DeepgramTts, on_event: Callable[[TtsEvent], None], sock: _Socket) -> None:
        self._p = provider
        self._on_event = on_event
        self._sock = sock
        self._closing = False
        self._retried = False
        #: Chunks flushed and not yet ``Flushed``, oldest first; audio belongs to the first.
        self._in_flight: list[_Segment] = []
        #: Text spoken for the next chunk (before its Flush).
        self._pending_text: dict[str, str] = {}
        self._cancelled: set[str] = set()
        self._clearing: _Clearing | None = None
        self._tasks: set[asyncio.Task[Any]] = set()
        self._attach(sock)

    # -- plumbing ---------------------------------------------------------------------------------------------------

    def _send(self, message: dict[str, Any]) -> None:
        if is_open(self._sock.ws):
            self._sock.outbox.put(json.dumps(message))

    def _send_chunk(self, segment: _Segment) -> None:
        self._in_flight.append(segment)
        self._send({"type": "Speak", "text": segment.text})
        self._send({"type": "Flush"})

    def _when_clear(self, action: Callable[[], None]) -> None:
        if self._clearing is not None:
            self._clearing.waiting.append(action)
        else:
            action()

    def _end_clearing(self) -> None:
        clearing = self._clearing
        if clearing is None:
            return
        if clearing.timer is not None:
            clearing.timer.cancel()
        waiting = clearing.waiting
        self._clearing = None
        self._in_flight = []
        for action in waiting:
            action()

    def _attach(self, sock: _Socket) -> None:
        sock.reader = asyncio.get_running_loop().create_task(self._read(sock))
        self._tasks.add(sock.reader)
        sock.reader.add_done_callback(self._tasks.discard)

    async def _read(self, sock: _Socket) -> None:
        try:
            async for data in sock.ws:
                if sock is not self._sock:
                    continue  # a replaced socket's late frames
                if isinstance(data, bytes):
                    segment = self._in_flight[0] if self._in_flight else None
                    if self._clearing is not None or segment is None or segment.turn_id in self._cancelled:
                        continue
                    self._on_event(TtsAudio(turn_id=segment.turn_id, pcm=bytes(data), sample_rate=TTS_SAMPLE_RATE))
                    continue
                try:
                    message = json.loads(data)
                except ValueError:
                    continue
                kind = message.get("type") if isinstance(message, dict) else None
                if kind == "Flushed":
                    segment = self._in_flight.pop(0) if self._in_flight else None
                    self._retried = False
                    # One event per chunk (TtsEvent "flushed"), never for a cancelled turn.
                    if segment is not None and segment.turn_id not in self._cancelled and self._clearing is None:
                        self._on_event(TtsFlushed(turn_id=segment.turn_id))
                elif kind == "Cleared" and not (self._clearing is not None and self._clearing.reopening):
                    # Too late once a fresh socket is on its way: the waiting speech goes there.
                    self._end_clearing()
        except Exception:
            pass
        finally:
            sock.outbox.stop()
            self._on_closed(sock)

    def _on_closed(self, sock: _Socket) -> None:
        if sock is not self._sock or self._closing:
            return
        # Dropped by the provider. Reopen once and resend what wasn't spoken yet; otherwise report the failure.
        unfinished = [s for s in self._in_flight if s.turn_id not in self._cancelled]
        self._in_flight = []
        if self._clearing is not None:
            # Still clearing: keep dropping frames and holding new speech until the new socket is ready.
            self._clearing.reopening = True
            spawn(self._reopen_then_end_clearing(), self._tasks)
        elif not self._retried and unfinished:
            self._retried = True
            spawn(self._reopen(unfinished), self._tasks)
        elif unfinished:
            self._on_event(TtsError(ConnectionError("Deepgram TTS connection lost")))
        else:
            spawn(self._reopen([]), self._tasks)

    async def _reopen_then_end_clearing(self) -> None:
        await self._reopen([])
        self._end_clearing()

    async def _reopen(self, resend: list[_Segment]) -> None:
        old = self._sock
        try:
            ws = await self._p.connect()
        except Exception as error:
            self._on_event(TtsError(error))
            return
        self._sock = _Socket(ws)
        self._attach(self._sock)
        if old.ws.state.name in ("OPEN", "CONNECTING"):
            terminate(old.ws)
        for segment in resend:
            self._send_chunk(segment)

    # -- TtsStream --------------------------------------------------------------------------------------------------

    def speak(self, turn_id: str, text: str) -> None:
        if turn_id in self._cancelled or not text:
            return
        self._pending_text[turn_id] = self._pending_text.get(turn_id, "") + text

    def flush(self, turn_id: str) -> None:
        text = self._pending_text.pop(turn_id, None)
        if not text or turn_id in self._cancelled:
            return

        def action() -> None:
            if turn_id not in self._cancelled:
                self._send_chunk(_Segment(turn_id, text))

        self._when_clear(action)

    def cancel(self, turn_id: str) -> None:
        self._cancelled.add(turn_id)
        self._pending_text.pop(turn_id, None)
        if not any(s.turn_id == turn_id for s in self._in_flight) or self._clearing is not None:
            return
        self._send({"type": "Clear"})
        clearing = _Clearing()
        self._clearing = clearing

        def on_timeout() -> None:
            # No Cleared: start over on a fresh socket. ``clearing`` stays set until it is open, so the old socket's
            # late frames are dropped and new speech waits for the new one (P5 review #6).
            if self._clearing is not None:
                self._clearing.reopening = True
            spawn(self._reopen_then_end_clearing(), self._tasks)

        clearing.timer = asyncio.get_running_loop().call_later(self._p.clear_timeout_ms / 1000, on_timeout)

    async def close(self) -> None:
        self._closing = True
        if self._clearing is not None and self._clearing.timer is not None:
            self._clearing.timer.cancel()
        sock = self._sock
        if not is_open(sock.ws):
            terminate(sock.ws)
        else:
            sock.outbox.put(json.dumps({"type": "Close"}))
            await sock.outbox.drain(1.0)
            try:
                await asyncio.wait_for(sock.ws.wait_closed(), 1.0)
            except TimeoutError:
                terminate(sock.ws)
        if sock.reader is not None:
            await asyncio.gather(sock.reader, return_exceptions=True)
        for task in list(self._tasks):
            if not task.done():
                task.cancel()
        with contextlib.suppress(Exception):
            await asyncio.gather(*self._tasks, return_exceptions=True)
        self._on_event(TtsClosed())


class DeepgramTts:
    def __init__(
        self,
        *,
        api_key: Any,
        url: str | None = None,
        voice: str = "aura-2-thalia-en",
        #: How long to wait for ``Cleared`` before reopening the socket.
        clear_timeout_ms: float = 1_000,
        connect_timeout_ms: float = 5_000,
    ) -> None:
        self._api_key = api_key
        self._url = deepgram_speak_url(url or DEEPGRAM_SPEAK_URL, voice)
        self.clear_timeout_ms = clear_timeout_ms
        self._connect_timeout_ms = connect_timeout_ms

    async def connect(self) -> Any:
        try:
            return await connect(
                self._url,
                additional_headers={"Authorization": f"Token {self._api_key.reveal()}"},
                open_timeout=self._connect_timeout_ms / 1000,
                ping_interval=None,
                compression=None,
            )
        except TimeoutError as error:
            raise TimeoutError("Deepgram TTS connect timed out") from error

    async def open(self, on_event: Callable[[TtsEvent], None]) -> TtsStream:
        ws = await self.connect()
        return DeepgramTtsStream(self, on_event, _Socket(ws))


def create_deepgram_tts(
    *,
    api_key: Any,
    url: str | None = None,
    voice: str = "aura-2-thalia-en",
    clear_timeout_ms: float = 1_000,
    connect_timeout_ms: float = 5_000,
) -> TtsProvider:
    return DeepgramTts(
        api_key=api_key, url=url, voice=voice, clear_timeout_ms=clear_timeout_ms, connect_timeout_ms=connect_timeout_ms
    )

"""A scriptable TTS provider (P5-T01).

Each flushed chunk becomes audio frames at 24 kHz (one 40 ms frame per ``chars_per_frame`` characters), emitted at once
or on the injected clock, then ``flushed``. ``cancel()`` drops the turn's remaining frames, as the real adapter does.
"""

from __future__ import annotations

import asyncio
import math
from collections.abc import Callable
from dataclasses import dataclass

from app.voice.clock import Clock
from app.voice.types import TtsAudio, TtsClosed, TtsError, TtsEvent, TtsFlushed, pcm_bytes_per_second

FAKE_TTS_RATE = 24_000
FAKE_FRAME_MS = 40
_FRAME_BYTES = pcm_bytes_per_second(FAKE_TTS_RATE) * FAKE_FRAME_MS // 1000


@dataclass(slots=True)
class FakeTtsOptions:
    #: With a clock, frames come one per FAKE_FRAME_MS; without, synchronously on flush.
    clock: Clock | None = None
    chars_per_frame: int = 4
    #: Clock time between frames (default FAKE_FRAME_MS: real time). Less is faster than real time, like Aura-2.
    interval_ms: float | None = None


class FakeTtsStream:
    def __init__(self, on_event: Callable[[TtsEvent], None], options: FakeTtsOptions) -> None:
        self.on_event = on_event
        self.options = options
        #: Every chunk flushed, in order: what the "voice" was asked to say.
        self.chunks: list[tuple[str, str]] = []
        self.cancelled_turns: list[str] = []
        self.closed = False
        #: Make the next flush fail with an error event (a provider error mid-call).
        self.fail_next_flush = False
        self._pending: dict[str, str] = {}
        self._cancelled: set[str] = set()
        self._jobs: list[Callable[[Callable[[], None]], None]] = []
        self._running = False

    def speak(self, turn_id: str, text: str) -> None:
        if turn_id in self._cancelled:
            return
        self._pending[turn_id] = self._pending.get(turn_id, "") + text

    def flush(self, turn_id: str) -> None:
        text = self._pending.pop(turn_id, None)
        if not text or turn_id in self._cancelled:
            return
        self.chunks.append((turn_id, text))
        if self.fail_next_flush:
            self.fail_next_flush = False
            self.on_event(TtsError(RuntimeError("fake TTS failed")))
            return
        frames = max(1, math.ceil(len(text) / self.options.chars_per_frame))
        clock = self.options.clock
        if clock is None:
            for _ in range(frames):
                self.on_event(TtsAudio(turn_id=turn_id, pcm=bytes(_FRAME_BYTES), sample_rate=FAKE_TTS_RATE))
            self.on_event(TtsFlushed(turn_id=turn_id))
            return
        interval = self.options.interval_ms if self.options.interval_ms is not None else FAKE_FRAME_MS

        # One chunk after another, like Aura-2: this chunk starts when the ones before it have played.
        def play(done: Callable[[], None]) -> None:
            sent = 0

            def next_frame() -> None:
                nonlocal sent
                if turn_id in self._cancelled or self.closed:
                    done()
                    return
                if sent < frames:
                    sent += 1
                    self.on_event(TtsAudio(turn_id=turn_id, pcm=bytes(_FRAME_BYTES), sample_rate=FAKE_TTS_RATE))
                    clock.set_timeout(next_frame, interval)
                else:
                    self.on_event(TtsFlushed(turn_id=turn_id))
                    done()

            clock.set_timeout(next_frame, 0)

        self._jobs.append(play)
        self._kick()

    def _kick(self) -> None:
        if self._running or not self._jobs:
            return
        self._running = True
        asyncio.get_running_loop().call_soon(self._start_next)

    def _start_next(self) -> None:
        play = self._jobs.pop(0)

        def done() -> None:
            self._running = False
            self._kick()

        play(done)

    def cancel(self, turn_id: str) -> None:
        self._cancelled.add(turn_id)
        self.cancelled_turns.append(turn_id)
        self._pending.pop(turn_id, None)

    async def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        self.on_event(TtsClosed())

    def spoken(self, turn_id: str | None = None) -> str:
        """The text spoken for a turn, chunks joined."""
        return " ".join(text for tid, text in self.chunks if turn_id is None or tid == turn_id)


class FakeTts:
    def __init__(self, options: FakeTtsOptions | None = None) -> None:
        self.options = options or FakeTtsOptions()
        self.streams: list[FakeTtsStream] = []
        self.fail_next_open = 0

    async def open(self, on_event: Callable[[TtsEvent], None]) -> FakeTtsStream:
        if self.fail_next_open > 0:
            self.fail_next_open -= 1
            raise RuntimeError("fake TTS unavailable")
        stream = FakeTtsStream(on_event, self.options)
        self.streams.append(stream)
        return stream

    @property
    def current(self) -> FakeTtsStream:
        if not self.streams:
            raise RuntimeError("no TTS stream open")
        return self.streams[-1]

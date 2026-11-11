"""A scriptable STT provider (P5-T01): tests push events by hand or replay a recorded Deepgram fixture."""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Sequence
from typing import Any

from app.voice.deepgram import to_stt_event
from app.voice.types import SttClosed, SttEvent, SttSpeechStarted, SttTranscript


class FakeSttStream:
    def __init__(self, on_event: Callable[[SttEvent], None]) -> None:
        self.on_event = on_event
        self.bytes = 0
        self.closed = False
        #: A provider that takes a while to close (shutdown must still commit EndCall, P5 review #4).
        self.close_delay_ms = 0

    def push(self, pcm: bytes) -> None:
        if not self.closed:
            self.bytes += len(pcm)

    async def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        if self.close_delay_ms > 0:
            await asyncio.sleep(self.close_delay_ms / 1000)
        self.on_event(SttClosed())

    def emit(self, event: SttEvent) -> None:
        if not self.closed:
            self.on_event(event)

    def say(self, text: str) -> None:
        """The user said ``text``: speechStarted, an interim, then a final that ends the speech."""
        self.emit(SttSpeechStarted())
        self.emit(SttTranscript(text=" ".join(text.split(" ")[:2]), is_final=False, speech_final=False))
        self.emit(SttTranscript(text=text, is_final=True, speech_final=True))

    def replay(self, messages: Sequence[Any]) -> None:
        """Emits a recorded fixture's Deepgram messages in order (no timing)."""
        for message in messages:
            event = to_stt_event(message)
            if event is not None:
                self.emit(event)


class FakeStt:
    def __init__(self) -> None:
        #: Every stream opened, newest last.
        self.streams: list[FakeSttStream] = []
        #: Make the next open() fail (a provider that can't be reached).
        self.fail_next_open = 0
        #: A provider that takes this long to open (the handshake from far away).
        self.open_delay_ms = 0

    async def open(self, on_event: Callable[[SttEvent], None]) -> FakeSttStream:
        if self.fail_next_open > 0:
            self.fail_next_open -= 1
            raise RuntimeError("fake STT unavailable")
        if self.open_delay_ms > 0:
            await asyncio.sleep(self.open_delay_ms / 1000)
        stream = FakeSttStream(on_event)
        self.streams.append(stream)
        return stream

    @property
    def current(self) -> FakeSttStream:
        if not self.streams:
            raise RuntimeError("no STT stream open")
        return self.streams[-1]

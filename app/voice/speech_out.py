"""Speech output (P5-T11): one agent turn at a time.

Streamed text -> sentence chunks -> TTS; the turn's audio frames go to the browser as ``audio`` messages; the agent
``transcript`` line (``ta_<callId>_<n>``, one id per turn) grows with the text sent and is final when the turn has been
spoken or was interrupted. It tracks the audio duration sent per chunk, so barge-in can truncate the line at what the
user actually heard (P5-T07), and the first-audio time.
"""

from __future__ import annotations

import asyncio
import base64
import math
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from app.agent.sentence_chunker import SentenceChunker
from app.protocol.enums import Role
from app.protocol.types import AudioMessage, CallServerMessage, TranscriptMessage
from app.voice.clock import Clock
from app.voice.types import TtsAudio, TtsEvent, TtsFlushed, TtsStream, pcm_bytes_per_second

#: What the call socket sends (protocol.md section 3.2).
CallMessage = CallServerMessage


@dataclass(frozen=True, slots=True)
class SpokenTurn:
    id: str
    #: All text sent to TTS (the full line when the turn completed).
    text: str
    interrupted: bool
    #: What the user heard, when interrupted (the line is truncated to this plus " [interrupted]").
    heard: str
    first_audio_at: float | None
    #: First text sent to TTS -> first audio back (the provider's time to first byte); None when no audio came.
    tts_ttfb_ms: int | None
    #: Characters sent to TTS (the ledger's Aura-2 meter).
    characters: int


@dataclass(slots=True)
class Chunk:
    text: str
    #: Audio received for this chunk so far.
    audio_ms: float = 0
    #: All of its audio has arrived (Flushed). None: not known (counts as complete).
    complete: bool | None = None
    #: When the browser starts playing it (the play cursor when its first frame arrived).
    start_at: float | None = None
    #: Its text has been sent to the browser: the transcript shows a sentence when its voice starts, not before.
    shown: bool = False


#: Speaking rate assumed before any chunk has finished (Aura-2 at a normal pace, about 15 characters a second).
DEFAULT_MS_PER_CHAR = 65

INTERRUPTED_MARK = " [interrupted]"

_NOT_SPACE_TAIL = re.compile(r"\S*$")
_SPACE = re.compile(r"\s")


def _js_round(value: float) -> int:
    return math.floor(value + 0.5)


def heard_text(chunks: list[Chunk], played_ms: float) -> str:
    """The words of ``chunks`` heard after ``played_ms`` of audio: whole chunks, then a proportional cut at a word boundary.

    A chunk whose audio is still arriving is as long as its text at the rate of the finished chunks (its received audio
    alone would make it look shorter, and fully heard).
    """
    done = [c for c in chunks if c.complete is not False and c.audio_ms > 0]
    chars = sum(len(c.text) for c in done)
    ms_per_char = sum(c.audio_ms for c in done) / chars if chars > 0 else DEFAULT_MS_PER_CHAR
    left = played_ms
    parts: list[str] = []
    for chunk in chunks:
        if left <= 0:
            break
        duration = max(chunk.audio_ms, len(chunk.text) * ms_per_char) if chunk.complete is False else chunk.audio_ms
        if duration <= left:
            parts.append(chunk.text)
            left -= duration
            continue
        cut = math.floor(len(chunk.text) * left / duration)
        partial = chunk.text[:cut]
        # A cut inside a word keeps only the words before it.
        if cut < len(chunk.text) and not _SPACE.match(chunk.text[cut]):
            partial = _NOT_SPACE_TAIL.sub("", partial)
        partial = partial.strip()
        if partial:
            parts.append(partial)
        break
    return " ".join(parts).strip()


class SpeechTurn:
    def __init__(self, id: str, tts: TtsStream, clock: Clock, send: Callable[[CallMessage], None]) -> None:
        self.id = id
        self.tts = tts
        self.clock = clock
        self.send = send
        self._chunker = SentenceChunker()
        self._chunks: list[Chunk] = []
        self._text = ""
        self._audio_bytes = 0
        self._first_audio_at: float | None = None
        self._first_speak_at: float | None = None
        # When the browser will have played everything received so far: each frame plays after the previous one, or when it
        # arrives if the player had run dry (a gap: ack -> follow-up, a slow route). P5 review #9.
        self._play_cursor: float | None = None
        self._unflushed = 0
        #: Chunks whose text the browser has been sent.
        self._shown = 0
        #: The turn finished sending audio; its final transcript waits until every chunk has been shown.
        self._final_pending = False
        self._reveal_timers: list[Any] = []
        self._ended = False
        self._finished = False
        self._cancelled: SpokenTurn | None = None
        self._on_interrupt: Callable[[SpokenTurn], None] | None = None
        #: Resolves when everything sent has been spoken (or the turn was cancelled).
        self.done: asyncio.Future[SpokenTurn] = asyncio.get_running_loop().create_future()

    @property
    def first_audio_at(self) -> float | None:
        return self._first_audio_at

    @property
    def audible(self) -> bool:
        """True once any audio of this turn reached the socket."""
        return self._first_audio_at is not None

    @property
    def finished(self) -> bool:
        """Everything was sent (or the turn was cancelled). The user may still be hearing it: see ``speaking``."""
        return self._finished

    def playback_ends_at(self) -> float:
        """When the browser will have played everything sent, assuming it plays continuously from the first frame.

        TTS sends faster than real time (Aura-2 delivers seconds of audio in a fraction of that), so this is later than
        ``done``.
        """
        return self._play_cursor if self._play_cursor is not None else self.clock.now()

    @property
    def text(self) -> str:
        """The text sent to TTS so far."""
        return self._text

    def break_chunk(self) -> None:
        """Speaks what the chunker holds now, as its own chunk (a templated acknowledgement mustn't wait for more text)."""
        if self._ended or self._cancelled:
            return
        for chunk in self._chunker.flush():
            self._send_chunk(chunk)

    @property
    def speaking(self) -> bool:
        """The user is (by the estimate) still hearing this turn: not cancelled, and audio is still coming or playing."""
        if self._cancelled:
            return False
        return not self._finished or self.clock.now() < self.playback_ends_at()

    async def played_out(self) -> SpokenTurn:
        """Returns when the turn has been played out (or interrupted, with the interrupted result)."""
        sent = await self.done
        if self._cancelled:
            return self._cancelled
        wait = self.playback_ends_at() - self.clock.now()
        if wait <= 0:
            return sent
        future: asyncio.Future[SpokenTurn] = asyncio.get_running_loop().create_future()

        def on_timer() -> None:
            self._on_interrupt = None
            if not future.done():
                future.set_result(self._cancelled or sent)

        timer = self.clock.set_timeout(on_timer, wait)

        def on_interrupt(interrupted: SpokenTurn) -> None:
            self.clock.clear_timeout(timer)
            if not future.done():
                future.set_result(interrupted)

        self._on_interrupt = on_interrupt
        try:
            return await future
        finally:
            self.clock.clear_timeout(timer)

    def say(self, delta: str) -> None:
        """Streamed text from the model (or a templated line)."""
        if self._ended or self._cancelled:
            return
        for chunk in self._chunker.push(delta):
            self._send_chunk(chunk)

    def end(self) -> None:
        """No more text: speak what is left."""
        if self._ended or self._cancelled:
            return
        self._ended = True
        for chunk in self._chunker.flush():
            self._send_chunk(chunk)
        self._maybe_finish()

    def _send_chunk(self, text: str) -> None:
        if self._first_speak_at is None:
            self._first_speak_at = self.clock.now()
        self._chunks.append(Chunk(text=text, audio_ms=0, complete=False))
        self._text = f"{self._text} {text}" if self._text else text
        self._unflushed += 1
        self.tts.speak(self.id, text)
        self.tts.flush(self.id)
        # The text is shown later, when this chunk's audio starts playing (_reveal), so the transcript keeps pace with the voice.

    def _schedule_reveal(self, index: int, at: float) -> None:
        wait = at - self.clock.now()
        if wait <= 0:
            self._reveal(index)
        else:
            self._reveal_timers.append(self.clock.set_timeout(lambda: self._reveal(index), wait))

    def _reveal(self, index: int) -> None:
        chunk = self._chunks[index] if index < len(self._chunks) else None
        if chunk is None or chunk.shown or self._cancelled:
            return
        for earlier in self._chunks[: index + 1]:
            if not earlier.shown:
                earlier.shown = True
                self._shown += 1
        text = " ".join(c.text for c in self._chunks[: index + 1])
        self.send(TranscriptMessage(id=self.id, role=Role.AGENT, text=text, final=False))
        self._send_final_if_ready()

    def _send_final_if_ready(self) -> None:
        if not self._final_pending or self._cancelled or self._shown < len(self._chunks):
            return
        self._final_pending = False
        if self._text:
            self.send(TranscriptMessage(id=self.id, role=Role.AGENT, text=self._text, final=True))

    def on_tts(self, event: TtsEvent) -> None:
        """A TTS event for this turn (the engine routes by turn id)."""
        if self._cancelled or self._finished:
            return
        if isinstance(event, TtsAudio):
            now = self.clock.now()
            if self._first_audio_at is None:
                self._first_audio_at = now
            starts_at = max(self._play_cursor if self._play_cursor is not None else now, now)
            self._play_cursor = starts_at + (len(event.pcm) * 1000) / pcm_bytes_per_second(event.sample_rate)
            self._audio_bytes += len(event.pcm)
            current_index = len(self._chunks) - self._unflushed
            current = self._chunks[current_index] if 0 <= current_index < len(self._chunks) else None
            if current is not None and current.start_at is None:
                current.start_at = starts_at
                self._schedule_reveal(current_index, starts_at)
            if current is not None:
                current.audio_ms += (len(event.pcm) * 1000) / pcm_bytes_per_second(event.sample_rate)
            self.send(AudioMessage(data=base64.b64encode(event.pcm).decode("ascii"), sample_rate=event.sample_rate))
        elif isinstance(event, TtsFlushed):
            finished_index = len(self._chunks) - self._unflushed
            finished = self._chunks[finished_index] if 0 <= finished_index < len(self._chunks) else None
            if finished is not None:
                finished.complete = True
                # A chunk that came back without any audio is shown when the player gets to it.
                if finished.start_at is None:
                    finished.start_at = max(
                        self._play_cursor if self._play_cursor is not None else self.clock.now(), self.clock.now()
                    )
                    self._schedule_reveal(finished_index, finished.start_at)
            self._unflushed = max(0, self._unflushed - 1)
            self._maybe_finish()

    def _maybe_finish(self) -> None:
        if not self._ended or self._unflushed > 0 or self._finished:
            return
        self._finished = True
        self._final_pending = True
        self._send_final_if_ready()  # otherwise the last reveal sends it
        self._resolve_done(self._result(False, self._text))

    def _resolve_done(self, turn: SpokenTurn) -> None:
        if not self.done.done():
            self.done.set_result(turn)

    def buffered_ms(self) -> float:
        """Audio sent but (by the estimate) not yet played: the client's buffer."""
        return max(0.0, self.playback_ends_at() - self.clock.now())

    def sent_ms(self) -> float:
        return sum(c.audio_ms for c in self._chunks)

    def cancel(self) -> SpokenTurn:
        """Barge-in (P5-T07): stop at once.

        The caller has already sent stopPlayback; here no more audio is forwarded, TTS drops the turn, and the line is
        truncated to what was heard (sent audio minus the client's buffer).
        """
        if self._cancelled:
            return self._cancelled
        # Sent completely and played out: nothing to interrupt.
        if self._finished and not self.speaking:
            return self._result(False, self._text)
        # Played = everything sent minus what is still queued in the browser.
        played_ms = max(0.0, self.sent_ms() - self.buffered_ms())
        heard = heard_text(self._chunks, played_ms)
        self.tts.cancel(self.id)
        for timer in self._reveal_timers:
            self.clock.clear_timeout(timer)
        self._final_pending = False
        self._finished = True
        self._cancelled = self._result(True, heard)
        # The line (maybe already sent as final with the full text) is corrected in place: same id. Nothing sent yet:
        # there is no line to correct.
        if self._text:
            self.send(
                TranscriptMessage(id=self.id, role=Role.AGENT, text=f"{heard}{INTERRUPTED_MARK}".strip(), final=True)
            )
        self._resolve_done(self._cancelled)
        if self._on_interrupt is not None:
            self._on_interrupt(self._cancelled)
        return self._cancelled

    def _result(self, interrupted: bool, heard: str) -> SpokenTurn:
        ttfb = None
        if self._first_audio_at is not None and self._first_speak_at is not None:
            ttfb = max(0, _js_round(self._first_audio_at - self._first_speak_at))
        return SpokenTurn(
            id=self.id,
            text=self._text,
            interrupted=interrupted,
            heard=heard,
            first_audio_at=self._first_audio_at,
            tts_ttfb_ms=ttfb,
            characters=sum(len(c.text) for c in self._chunks),
        )

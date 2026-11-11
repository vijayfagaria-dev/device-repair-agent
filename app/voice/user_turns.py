"""The user side of the call (P5-T03).

STT events -> transcript lines (one id per utterance, ``tu_<callId>_<n>``, reused by every interim and the final,
protocol.md section 1.1) and the end of the user's turn. Deepgram's ``speech_final`` ends the turn (P0-T03: it always
came before UtteranceEnd), after a short merge window so a pause mid-sentence doesn't split it; ``UtteranceEnd`` is the
backstop.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from app.voice.clock import Clock
from app.voice.types import SttEvent, SttSpeechStarted, SttTranscript, SttUtteranceEnd


@dataclass(frozen=True, slots=True)
class UserLine:
    id: str
    text: str
    final: bool


@dataclass(frozen=True, slots=True)
class Utterance:
    id: str
    text: str
    #: When the first words were heard and when the turn ended (ms, the clock's).
    started_at: float
    ended_at: float
    #: When STT said the utterance was over (the last ``speech_final`` or ``UtteranceEnd``), before the merge window:
    #: the start of the server-side latency (D20). ``ended_at - end_event_at`` is the turn's own finalization wait.
    end_event_at: float


def _words(text: str) -> int:
    return len(text.split())


class _Current:
    __slots__ = ("finals", "id", "interim", "started_at")

    def __init__(self, id_: str, started_at: float) -> None:
        self.id = id_
        self.finals: list[str] = []
        self.interim = ""
        self.started_at = started_at


class UserTurns:
    def __init__(
        self,
        *,
        call_id: str,
        clock: Clock,
        on_line: Callable[[UserLine], None],
        on_turn_end: Callable[[Utterance], None],
        merge_ms: float = 300,
        on_speech_started: Callable[[], None] | None = None,
        #: Voice activity that never became words (echo, a cough, noise): the speaker is silent again.
        on_speech_abandoned: Callable[[], None] | None = None,
        #: How long voice activity may go without words before it counts as nothing (default 1.5 s).
        no_words_ms: float = 1_500,
    ) -> None:
        self._call_id = call_id
        self._clock = clock
        self._on_line = on_line
        self._on_turn_end = on_turn_end
        self._on_speech_started = on_speech_started
        self._on_speech_abandoned = on_speech_abandoned
        self._no_words_ms = no_words_ms
        self._merge_ms = merge_ms
        self._count = 0
        self._current: _Current | None = None
        self._end_timer: Any = None
        self._end_event_at: float | None = None
        self._speech_started_at: float | None = None
        self._no_words_timer: Any = None

    @property
    def words(self) -> int:
        """Words heard so far in the utterance in progress (barge-in confirmation, P5-T07)."""
        c = self._current
        return _words(" ".join([*c.finals, c.interim])) if c else 0

    @property
    def speech_started_at(self) -> float | None:
        """When voice activity started (speechStarted), until the utterance ends."""
        return self._speech_started_at

    @property
    def speaking(self) -> bool:
        return self._current is not None or self._speech_started_at is not None

    def handle(self, event: SttEvent) -> None:
        if isinstance(event, SttSpeechStarted):
            if self._speech_started_at is None:
                self._speech_started_at = self._clock.now()
            # Deepgram sends UtteranceEnd only after words, so activity that never becomes words must expire on its own
            # (P5 review #7: otherwise "speaking" stays true and silence handling stops).
            if self._current is None:
                if self._no_words_timer is not None:
                    self._clock.clear_timeout(self._no_words_timer)
                self._no_words_timer = self._clock.set_timeout(self._no_words_expired, self._no_words_ms)
            if self._on_speech_started:
                self._on_speech_started()
        elif isinstance(event, SttTranscript):
            self._transcript(event.text.strip(), event.is_final, event.speech_final)
        elif isinstance(event, SttUtteranceEnd):
            if self._current is not None:
                self._end_event_at = self._clock.now()
                self._end()
            elif self._speech_started_at is not None:
                self._speech_started_at = None  # noise that never became words
                if self._on_speech_abandoned:
                    self._on_speech_abandoned()

    def _no_words_expired(self) -> None:
        self._no_words_timer = None
        if self._current is not None:
            return
        self._speech_started_at = None
        if self._on_speech_abandoned:
            self._on_speech_abandoned()

    def _transcript(self, text: str, is_final: bool, speech_final: bool) -> None:
        if text:
            self._cancel_end()
            if self._no_words_timer is not None:
                self._clock.clear_timeout(self._no_words_timer)
            self._no_words_timer = None
            if self._current is None:
                self._count += 1
                started = self._speech_started_at if self._speech_started_at is not None else self._clock.now()
                self._current = _Current(f"tu_{self._call_id}_{self._count}", started)
            if is_final:
                self._current.finals.append(text)
                self._current.interim = ""
            else:
                self._current.interim = text
            c = self._current
            self._on_line(UserLine(c.id, " ".join(part for part in [*c.finals, c.interim] if part), False))
        if speech_final and self._current is not None:
            self._end_event_at = self._clock.now()
        if speech_final and self._current is not None and self._end_timer is None:
            self._end_timer = self._clock.set_timeout(self._merge_expired, self._merge_ms)

    def _merge_expired(self) -> None:
        self._end_timer = None
        self._end()

    def _cancel_end(self) -> None:
        if self._end_timer is not None:
            self._clock.clear_timeout(self._end_timer)
        self._end_timer = None

    def _end(self) -> None:
        self._cancel_end()
        c = self._current
        end_event_at = self._end_event_at if self._end_event_at is not None else self._clock.now()
        self._current = None
        self._end_event_at = None
        self._speech_started_at = None
        if c is None:
            return
        text = (" ".join(c.finals) if c.finals else c.interim).strip()
        self._on_line(UserLine(c.id, text, True))
        if text:
            self._on_turn_end(Utterance(c.id, text, c.started_at, self._clock.now(), end_event_at))

    def flush(self) -> None:
        """Ends any utterance in progress now (the call is ending)."""
        if self._current is not None:
            self._end()

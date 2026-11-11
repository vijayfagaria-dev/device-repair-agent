"""Provider interfaces for the call (P5-T01).

The call engine is written against these only, so providers can be swapped and tests can run on scripted fakes
(``voice/fakes/*``) without network or cost. Provider specifics (message names, URLs, auth) stay in the adapters:
``voice/deepgram.py``, ``voice/deepgram_tts.py``, ``agent/llm.py``.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Any, ClassVar, Literal, Protocol

# ---------------------------------------------------------------------------------------------------------------------
# Aborting (the TS AbortController/AbortSignal)


class AbortSignal:
    """A one-way flag with callbacks: ``abort()`` once, everything waiting on it is told."""

    def __init__(self) -> None:
        self._aborted = False
        self._callbacks: list[Callable[[], None]] = []
        self._event: asyncio.Event | None = None

    @property
    def aborted(self) -> bool:
        return self._aborted

    def abort(self) -> None:
        if self._aborted:
            return
        self._aborted = True
        if self._event is not None:
            self._event.set()
        callbacks, self._callbacks = self._callbacks, []
        for callback in callbacks:
            callback()

    def add_callback(self, callback: Callable[[], None]) -> None:
        """Calls ``callback`` on abort (at once if already aborted)."""
        if self._aborted:
            callback()
        else:
            self._callbacks.append(callback)

    def remove_callback(self, callback: Callable[[], None]) -> None:
        if callback in self._callbacks:
            self._callbacks.remove(callback)

    async def wait(self) -> None:
        if self._aborted:
            return
        if self._event is None:
            self._event = asyncio.Event()
        await self._event.wait()


# ---------------------------------------------------------------------------------------------------------------------
# Speech to text


@dataclass(frozen=True, slots=True)
class SttSpeechStarted:
    """Voice activity began (Deepgram ``SpeechStarted``): the earliest barge-in signal."""

    type: ClassVar[str] = "speechStarted"


@dataclass(frozen=True, slots=True)
class SttTranscript:
    """A transcript for the current segment.

    ``is_final``: this segment's text won't change again. ``speech_final``: the speaker paused long enough
    (endpointing) that this is the end of what they were saying.
    """

    text: str
    is_final: bool
    speech_final: bool
    type: ClassVar[str] = "transcript"


@dataclass(frozen=True, slots=True)
class SttUtteranceEnd:
    """No words for a while after the last final (Deepgram ``UtteranceEnd``): a backstop end of turn."""

    type: ClassVar[str] = "utteranceEnd"


@dataclass(frozen=True, slots=True)
class SttError:
    """The stream failed; the adapter has stopped."""

    error: Exception
    type: ClassVar[str] = "error"


@dataclass(frozen=True, slots=True)
class SttClosed:
    """The stream ended (after close(), or the provider closed it)."""

    type: ClassVar[str] = "closed"


SttEvent = SttSpeechStarted | SttTranscript | SttUtteranceEnd | SttError | SttClosed


class SttStream(Protocol):
    def push(self, pcm: bytes) -> None:
        """One 20 ms frame of PCM16 mono at 16 kHz (protocol.md section 3.1)."""
        ...

    async def close(self) -> None:
        """Flushes what is buffered and closes; returns once closed."""
        ...


class SttProvider(Protocol):
    async def open(self, on_event: Callable[[SttEvent], None]) -> SttStream:
        """Opens a stream; ``on_event`` receives every event in order. Raises if the stream can't be opened."""
        ...


# ---------------------------------------------------------------------------------------------------------------------
# Language model


@dataclass(frozen=True, slots=True)
class ChatToolCall:
    id: str
    name: str
    #: The raw JSON arguments as streamed (validated by the turn engine, never trusted).
    arguments: str
    #: Provider data that must be echoed back with the call in the follow-up (Gemini's thought_signature).
    extra: dict[str, Any] | None = None


@dataclass(slots=True)
class LlmMessage:
    """One chat message. ``role`` is system, user, assistant or tool; mutable (an interrupted line is rewritten)."""

    role: Literal["system", "user", "assistant", "tool"]
    content: str | None
    #: assistant only
    tool_calls: list[ChatToolCall] | None = None
    #: tool only
    tool_call_id: str | None = None


@dataclass(frozen=True, slots=True)
class ToolDefinition:
    name: str
    description: str
    #: JSON Schema of the arguments.
    parameters: dict[str, Any]


@dataclass(frozen=True, slots=True)
class LlmRoute:
    """Which provider and model actually answered (the fallback chain may have moved on)."""

    provider: Literal["groq", "gemini"]
    model: str


@dataclass(slots=True)
class LlmRequest:
    messages: list[LlmMessage]
    tools: list[ToolDefinition]
    signal: AbortSignal | None = None
    #: A route failed and ``next`` is about to be tried (the turn engine says "One moment." before the last resort).
    on_fallback: Callable[[LlmRoute], None] | None = None


@dataclass(frozen=True, slots=True)
class LlmUsage:
    prompt_tokens: int
    completion_tokens: int
    cached_tokens: int


@dataclass(frozen=True, slots=True)
class TextChunk:
    delta: str
    type: ClassVar[str] = "text"


@dataclass(frozen=True, slots=True)
class ToolCallChunk:
    """A complete tool call (arguments fully streamed)."""

    call: ChatToolCall
    type: ClassVar[str] = "toolCall"


@dataclass(frozen=True, slots=True)
class UsageChunk:
    usage: LlmUsage
    type: ClassVar[str] = "usage"


@dataclass(frozen=True, slots=True)
class DoneChunk:
    finish_reason: str | None
    type: ClassVar[str] = "done"


LlmChunk = TextChunk | ToolCallChunk | UsageChunk | DoneChunk


class LlmTurnStream(Protocol):
    @property
    def route(self) -> LlmRoute: ...

    @property
    def ttft_ms(self) -> int | None:
        """Milliseconds from the request to the first text or tool call (TTFT), once known."""
        ...

    def __aiter__(self) -> AsyncIterator[LlmChunk]: ...

    async def aclose(self) -> None:
        """Releases the stream (cancels the provider request); safe to call twice."""
        ...


class LlmClient(Protocol):
    async def stream(self, request: LlmRequest) -> LlmTurnStream:
        """Starts one model call.

        Returns once the first output has arrived (so the fallback chain can move on before anything was emitted);
        raises ``LlmError`` when every route failed.
        """
        ...


class LlmError(Exception):
    """``status``: the HTTP status, or "timeout" / "aborted" / "empty", or None (network)."""

    def __init__(self, message: str, status: int | Literal["timeout", "aborted", "empty"] | None) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


# ---------------------------------------------------------------------------------------------------------------------
# Text to speech


@dataclass(frozen=True, slots=True)
class TtsAudio:
    """PCM16 mono audio for ``turn_id`` (frames of a cancelled turn are never emitted)."""

    turn_id: str
    pcm: bytes
    sample_rate: int
    type: ClassVar[str] = "audio"


@dataclass(frozen=True, slots=True)
class TtsFlushed:
    """One chunk of ``turn_id`` (its speak ... flush) has been spoken: one event per flush, in order.

    Per chunk, not per turn: the speech pipeline counts them to know when a turn is done.
    """

    turn_id: str
    type: ClassVar[str] = "flushed"


@dataclass(frozen=True, slots=True)
class TtsError:
    error: Exception
    type: ClassVar[str] = "error"


@dataclass(frozen=True, slots=True)
class TtsClosed:
    type: ClassVar[str] = "closed"


TtsEvent = TtsAudio | TtsFlushed | TtsError | TtsClosed


class TtsStream(Protocol):
    def speak(self, turn_id: str, text: str) -> None:
        """Queues text for a turn. Text of one turn is spoken in order; ``flush`` marks the end of a chunk."""
        ...

    def flush(self, turn_id: str) -> None: ...

    def cancel(self, turn_id: str) -> None:
        """Stops a turn at once: no more of its audio is emitted (late provider frames are dropped)."""
        ...

    async def close(self) -> None: ...


class TtsProvider(Protocol):
    async def open(self, on_event: Callable[[TtsEvent], None]) -> TtsStream: ...


def pcm_bytes_per_second(sample_rate: int) -> int:
    """Bytes per second of PCM16 mono at a rate (2 bytes per sample)."""
    return sample_rate * 2


__all__ = [
    "AbortSignal",
    "ChatToolCall",
    "DoneChunk",
    "LlmChunk",
    "LlmClient",
    "LlmError",
    "LlmMessage",
    "LlmRequest",
    "LlmRoute",
    "LlmTurnStream",
    "LlmUsage",
    "SttClosed",
    "SttError",
    "SttEvent",
    "SttProvider",
    "SttSpeechStarted",
    "SttStream",
    "SttTranscript",
    "SttUtteranceEnd",
    "TextChunk",
    "ToolCallChunk",
    "ToolDefinition",
    "TtsAudio",
    "TtsClosed",
    "TtsError",
    "TtsEvent",
    "TtsFlushed",
    "TtsProvider",
    "TtsStream",
    "UsageChunk",
    "pcm_bytes_per_second",
]

"""A scriptable LLM (P5-T01).

Each call takes the next script. Scripts are text, tool calls, usage, a failure, or a route that fails first so the next
one answers (the fallback chain), mirroring ``agent/llm.py``'s contract.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from app.voice.types import (
    ChatToolCall,
    DoneChunk,
    LlmChunk,
    LlmError,
    LlmRequest,
    LlmRoute,
    LlmUsage,
    TextChunk,
    ToolCallChunk,
    UsageChunk,
)

DEFAULT_ROUTE = LlmRoute(provider="groq", model="openai/gpt-oss-20b")


@dataclass(slots=True)
class LlmScript:
    text: str | None = None
    #: Each: ``{"name": ..., "args": dict | str, "id": optional, "extra": optional}``.
    tool_calls: list[dict[str, Any]] | None = None
    #: Raised instead of answering.
    error: LlmError | None = None
    route: LlmRoute | None = None
    #: ``{"prompt_tokens", "completion_tokens", "cached_tokens"?}``
    usage: dict[str, int] | None = None
    #: Deliver the text in pieces this long (to exercise streaming).
    piece_chars: int | None = None
    #: Wait for this before yielding each chunk (lets tests interleave).
    gate: Callable[[], Awaitable[None]] | None = None
    #: The stream raises after this many chunks (a connection that dies mid-reply, as on the live call of 2026-11-11).
    break_after: int | None = None
    #: The first route failed and this one answered: ``on_fallback`` is called first, as the real router does.
    fell_back: bool = False


class _FakeStream:
    def __init__(self, route: LlmRoute, chunks: list[LlmChunk], script: LlmScript, request: LlmRequest) -> None:
        self.route = route
        self.ttft_ms: int | None = 120
        self._chunks = chunks
        self._script = script
        self._signal = request.signal

    def __aiter__(self) -> AsyncIterator[LlmChunk]:
        return self._iterate()

    async def _iterate(self) -> AsyncIterator[LlmChunk]:
        sent = 0
        script = self._script
        for chunk in self._chunks:
            if script.break_after is not None:
                if sent >= script.break_after:
                    raise LlmError("stream broke", None)
                sent += 1
            if script.gate is not None:
                await script.gate()
            if self._signal is not None and self._signal.aborted:
                return
            yield chunk

    async def aclose(self) -> None:
        return None


class FakeLlm:
    def __init__(self) -> None:
        self.requests: list[LlmRequest] = []
        self._scripts: list[LlmScript] = []
        #: Used when no script is queued.
        self.fallback = LlmScript(text="Okay.")

    def enqueue(self, *scripts: LlmScript) -> FakeLlm:
        self._scripts.extend(scripts)
        return self

    @property
    def queued(self) -> int:
        return len(self._scripts)

    async def stream(self, request: LlmRequest) -> _FakeStream:
        self.requests.append(
            LlmRequest(
                messages=list(request.messages),
                tools=request.tools,
                signal=request.signal,
                on_fallback=request.on_fallback,
            )
        )
        script = self._scripts.pop(0) if self._scripts else self.fallback
        if script.error is not None:
            raise script.error
        if request.signal is not None and request.signal.aborted:
            raise LlmError("aborted", "aborted")
        if script.fell_back and request.on_fallback is not None:
            request.on_fallback(script.route or DEFAULT_ROUTE)
        chunks: list[LlmChunk] = []
        text = script.text or ""
        size = script.piece_chars or (len(text) or 1)
        for i in range(0, len(text), size):
            chunks.append(TextChunk(text[i : i + size]))
        for i, call in enumerate(script.tool_calls or []):
            args = call["args"]
            chunks.append(
                ToolCallChunk(
                    ChatToolCall(
                        id=call.get("id") or f"call_{len(self.requests)}_{i}",
                        name=call["name"],
                        arguments=args if isinstance(args, str) else json.dumps(args, separators=(",", ":")),
                        extra=call.get("extra"),
                    )
                )
            )
        usage = script.usage or {}
        chunks.append(
            UsageChunk(
                LlmUsage(
                    usage.get("prompt_tokens", 900), usage.get("completion_tokens", 20), usage.get("cached_tokens", 0)
                )
            )
        )
        chunks.append(DoneChunk("tool_calls" if script.tool_calls else "stop"))
        return _FakeStream(script.route or DEFAULT_ROUTE, chunks, script, request)

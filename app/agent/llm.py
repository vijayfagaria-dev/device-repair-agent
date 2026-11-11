"""The call agent's LLM (P5-T06, D06).

One ``openai`` SDK client per provider (Groq, and Gemini's OpenAI-compatible endpoint) behind the LlmClient interface.
A turn goes to the first route; on 429, 5xx, a network error or no first output within the TTFT timeout (5 s) it moves
to the next route, before anything was emitted, so prompts and tools are identical on every hop. Tool calls are
accumulated by ``index``, a new ``id`` starting a new call (Gemini reuses index 0); Gemini's ``extra_content``
(thought_signature) is kept so the follow-up can echo it (P0-T03).
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import Any, TypeVar

from openai import AsyncOpenAI

from app.voice.types import (
    AbortSignal,
    ChatToolCall,
    DoneChunk,
    LlmChunk,
    LlmClient,
    LlmError,
    LlmMessage,
    LlmRequest,
    LlmRoute,
    LlmTurnStream,
    LlmUsage,
    TextChunk,
    ToolCallChunk,
    UsageChunk,
)

GROQ_BASE_URL = "https://api.groq.com/openai/v1"
GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"

T = TypeVar("T")


@dataclass(slots=True)
class LlmHop:
    """One route and the client that serves it."""

    provider: Any  # "groq" | "gemini"
    model: str
    #: Anything with ``chat.completions.create`` (an ``AsyncOpenAI`` in production, a fake in tests).
    client: Any
    #: Provider-specific request params (Groq gpt-oss: reasoning_effort "low"; Gemini rejects it).
    extra: dict[str, Any] = field(default_factory=dict)


def llm_hops(*, groq_api_key: Any, gemini_api_key: Any | None, models: Sequence[str]) -> list[LlmHop]:
    """One route per configured model: ``groq:<model>`` or ``gemini:<model>``; Gemini only with a key.

    The keys are ``Secret`` objects (``.reveal()``).
    """
    groq = AsyncOpenAI(api_key=groq_api_key.reveal(), base_url=GROQ_BASE_URL, max_retries=0, timeout=20)
    gemini = (
        AsyncOpenAI(api_key=gemini_api_key.reveal(), base_url=GEMINI_BASE_URL, max_retries=0, timeout=20)
        if gemini_api_key
        else None
    )
    hops: list[LlmHop] = []
    for entry in models:
        provider, _, model = entry.partition(":")
        if provider == "groq":
            hops.append(
                LlmHop(provider, model, groq, {"reasoning_effort": "low"} if model.startswith("openai/gpt-oss") else {})
            )
        elif provider == "gemini" and gemini is not None:
            hops.append(LlmHop(provider, model, gemini, {}))
    return hops


def to_openai_messages(messages: Sequence[LlmMessage]) -> list[dict[str, Any]]:
    """LlmMessage -> the OpenAI chat format (tool calls with Gemini's extra_content echoed)."""
    out: list[dict[str, Any]] = []
    for m in messages:
        if m.role == "assistant":
            message: dict[str, Any] = {"role": "assistant", "content": m.content}
            if m.tool_calls:
                calls = []
                for c in m.tool_calls:
                    call: dict[str, Any] = {
                        "id": c.id,
                        "type": "function",
                        "function": {"name": c.name, "arguments": c.arguments},
                    }
                    if c.extra:
                        call["extra_content"] = c.extra
                    calls.append(call)
                message["tool_calls"] = calls
            out.append(message)
        elif m.role == "tool":
            out.append({"role": "tool", "tool_call_id": m.tool_call_id, "content": m.content})
        else:
            out.append({"role": m.role, "content": m.content})
    return out


def should_fall_back(status: int | str | None) -> bool:
    """Whether the next route should take over (D06: 429 or 5xx; also timeouts and network errors)."""
    return (
        status is None
        or status == "timeout"
        or status == 429
        or (isinstance(status, int) and not isinstance(status, bool) and status >= 500)
    )


def _to_llm_error(err: BaseException, timed_out: bool) -> LlmError:
    if timed_out:
        return LlmError("no first output within the TTFT timeout", "timeout")
    if isinstance(err, LlmError):
        return err
    status = getattr(err, "status", None)
    if not isinstance(status, int) or isinstance(status, bool):
        status = getattr(err, "status_code", None)
    return LlmError(str(err)[:200], status if isinstance(status, int) and not isinstance(status, bool) else None)


@dataclass(slots=True)
class _Pending:
    id: str | None
    name: str = ""
    args: str = ""
    extra: dict[str, Any] | None = None


class _Aborted(Exception):
    """Raised inside a hop when its controller was aborted (by the caller, or by the TTFT timer)."""


class _Controller:
    """The hop's own abort handle: cancels whatever the hop is awaiting."""

    def __init__(self) -> None:
        self.signal = AbortSignal()
        self._current: asyncio.Task[Any] | None = None
        self.signal.add_callback(self._cancel_current)

    def _cancel_current(self) -> None:
        if self._current is not None and not self._current.done():
            self._current.cancel()

    def abort(self) -> None:
        self.signal.abort()

    async def run(self, awaitable: Awaitable[T]) -> T:
        """Awaits ``awaitable``; if the controller aborts meanwhile, it is cancelled and ``_Aborted`` raised."""
        if self.signal.aborted:
            if asyncio.iscoroutine(awaitable):
                awaitable.close()
            raise _Aborted
        task = asyncio.ensure_future(awaitable)
        self._current = task
        try:
            return await task
        except asyncio.CancelledError:
            if self.signal.aborted and not _outer_cancelled():
                raise _Aborted from None
            raise
        finally:
            self._current = None


def _outer_cancelled() -> bool:
    task = asyncio.current_task()
    return task is not None and task.cancelling() > 0


def _as_dict(chunk: Any) -> dict[str, Any]:
    if isinstance(chunk, dict):
        return chunk
    dump = getattr(chunk, "model_dump", None)
    return dump() if dump is not None else dict(chunk)


@dataclass(slots=True)
class LlmRouterOptions:
    hops: Sequence[LlmHop]
    ttft_timeout_ms: float = 5_000
    max_tokens: int = 400
    temperature: float = 0.3
    now: Callable[[], float] = lambda: time.perf_counter() * 1000
    #: Told about every hop that failed (for the log and the quota guard).
    on_hop_failed: Callable[[LlmRoute, LlmError], None] | None = None


class _HopStream:
    """One open route: the first output has arrived; the rest is read lazily."""

    def __init__(
        self,
        route: LlmRoute,
        iterator: Any,
        sdk_stream: Any,
        controller: _Controller,
        done: Callable[[], None],
        now: Callable[[], float],
        started: float,
    ) -> None:
        self.route = route
        self._iterator = iterator
        self._sdk_stream = sdk_stream
        self._controller = controller
        self._done = done
        self._now = now
        self._started = started
        self.calls: dict[str, _Pending] = {}
        self.finish_reason: str | None = None
        self.buffered: list[LlmChunk] = []
        self.usage: LlmUsage | None = None
        self._ttft_ms: int | None = None
        self.timed_out = False
        self.more = True
        self._closed = False
        self._timer: asyncio.TimerHandle | None = None

    @property
    def ttft_ms(self) -> int | None:
        return self._ttft_ms

    def set_timer(self, timer: asyncio.TimerHandle) -> None:
        self._timer = timer

    def _clear_timer(self) -> None:
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None

    async def pull(self) -> bool:
        """Reads SDK chunks until it has LlmChunks to give (or the stream ended)."""
        while True:
            try:
                raw = await self._controller.run(self._iterator.__anext__())
            except StopAsyncIteration:
                return False
            except _Aborted:
                raise (
                    _to_llm_error(_Aborted(), self.timed_out) if self.timed_out else LlmError("aborted", "aborted")
                ) from None
            except asyncio.CancelledError:
                raise
            except Exception as err:
                raise _to_llm_error(err, self.timed_out) from err
            chunk = _as_dict(raw)
            usage = chunk.get("usage")
            if usage:
                details = usage.get("prompt_tokens_details") or {}
                cached = details.get("cached_tokens") or 0
                self.usage = LlmUsage(usage.get("prompt_tokens") or 0, usage.get("completion_tokens") or 0, cached)
            choices = chunk.get("choices") or []
            choice = choices[0] if choices else None
            if choice and choice.get("finish_reason"):
                self.finish_reason = choice["finish_reason"]
            delta = (choice or {}).get("delta")
            if delta and self._ttft_ms is None and (delta.get("content") or delta.get("tool_calls")):
                self._ttft_ms = round(self._now() - self._started)
                self._clear_timer()
            if delta and delta.get("content"):
                self.buffered.append(TextChunk(delta["content"]))
            for tc in (delta or {}).get("tool_calls") or []:
                index = tc.get("index")
                key = str(index if index is not None else 0)
                existing = self.calls.get(key)
                if tc.get("id") and existing and existing.id and existing.id != tc["id"]:
                    key = f"{key}:{tc['id']}"
                current = self.calls.get(key) or _Pending(id=tc.get("id"))
                if tc.get("id"):
                    current.id = tc["id"]
                function = tc.get("function") or {}
                if function.get("name"):
                    current.name += function["name"]
                if function.get("arguments"):
                    current.args += function["arguments"]
                if tc.get("extra_content"):
                    current.extra = tc["extra_content"]
                self.calls[key] = current
            if self.buffered:
                return True

    def final_calls(self) -> list[ChatToolCall]:
        return [
            ChatToolCall(id=c.id or f"call_{i}", name=c.name, arguments=c.args or "{}", extra=c.extra)
            for i, c in enumerate(self.calls.values())
        ]

    def release(self) -> None:
        self._clear_timer()
        self._done()

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        self.release()
        self._controller.abort()
        close = getattr(self._sdk_stream, "close", None)
        if close is not None:
            with contextlib.suppress(Exception):
                result = close()
                if asyncio.iscoroutine(result):
                    await result

    async def chunks(self) -> AsyncIterator[LlmChunk]:
        try:
            while True:
                while self.buffered:
                    yield self.buffered.pop(0)
                if not self.more:
                    break
                self.more = await self.pull()
            for call in self.final_calls():
                yield ToolCallChunk(call)
            if self.usage:
                yield UsageChunk(self.usage)
            yield DoneChunk(self.finish_reason)
        finally:
            await self.aclose()


class _RouterStream:
    """The LlmTurnStream the router returns."""

    def __init__(self, hop_stream: _HopStream) -> None:
        self._hop = hop_stream
        self._iterator: AsyncIterator[LlmChunk] | None = None

    @property
    def route(self) -> LlmRoute:
        return self._hop.route

    @property
    def ttft_ms(self) -> int | None:
        return self._hop.ttft_ms

    def __aiter__(self) -> AsyncIterator[LlmChunk]:
        if self._iterator is None:
            self._iterator = self._hop.chunks()
        return self._iterator

    async def aclose(self) -> None:
        if self._iterator is not None:
            await self._iterator.aclose()  # type: ignore[attr-defined]
        await self._hop.aclose()


class LlmRouter:
    """The router: ``stream(request)`` tries each hop in turn (the fallback chain, D06)."""

    def __init__(self, options: LlmRouterOptions) -> None:
        self._o = options

    async def _open_hop(self, hop: LlmHop, request: LlmRequest) -> LlmTurnStream:
        controller = _Controller()
        signal = request.signal
        if signal is not None:
            signal.add_callback(controller.abort)
        route = LlmRoute(provider=hop.provider, model=hop.model)
        now = self._o.now
        started = now()
        state: dict[str, Any] = {"timed_out": False}

        def on_timeout() -> None:
            state["timed_out"] = True
            if hop_stream is not None:
                hop_stream.timed_out = True
            controller.abort()

        timer = asyncio.get_running_loop().call_later(self._o.ttft_timeout_ms / 1000, on_timeout)

        def done() -> None:
            timer.cancel()
            if signal is not None:
                signal.remove_callback(controller.abort)

        hop_stream: _HopStream | None = None
        sdk_stream: Any = None
        try:
            sdk_stream = await controller.run(
                hop.client.chat.completions.create(
                    model=hop.model,
                    messages=to_openai_messages(request.messages),
                    tools=[
                        {
                            "type": "function",
                            "function": {"name": t.name, "description": t.description, "parameters": t.parameters},
                        }
                        for t in request.tools
                    ],
                    tool_choice="auto",
                    stream=True,
                    stream_options={"include_usage": True},
                    max_tokens=self._o.max_tokens,
                    temperature=self._o.temperature,
                    **hop.extra,
                )
            )
        except _Aborted:
            done()
            raise (_to_llm_error(_Aborted(), True) if state["timed_out"] else LlmError("aborted", "aborted")) from None
        except asyncio.CancelledError:
            done()
            raise
        except Exception as err:
            done()
            raise _to_llm_error(err, state["timed_out"]) from err

        iterator = sdk_stream.__aiter__()
        hop_stream = _HopStream(route, iterator, sdk_stream, controller, done, now, started)
        hop_stream.set_timer(timer)
        hop_stream.timed_out = state["timed_out"]

        # Wait for the first output before committing to this route; a failure until then lets the next one try.
        try:
            hop_stream.more = await hop_stream.pull()
            while hop_stream.more and not any(isinstance(c, TextChunk) for c in hop_stream.buffered):
                hop_stream.more = await hop_stream.pull()
        except BaseException:
            await hop_stream.aclose()
            raise
        if (
            hop_stream.ttft_ms is None
            and not hop_stream.calls
            and not any(isinstance(c, TextChunk) for c in hop_stream.buffered)
        ):
            await hop_stream.aclose()
            raise LlmError("the model returned no output", "empty")
        return _RouterStream(hop_stream)

    async def stream(self, request: LlmRequest) -> LlmTurnStream:
        last: LlmError | None = None
        hops = list(self._o.hops)
        for i, hop in enumerate(hops):
            if request.signal is not None and request.signal.aborted:
                raise LlmError("aborted", "aborted")
            try:
                return await self._open_hop(hop, request)
            except asyncio.CancelledError:
                raise
            except Exception as err:
                error = _to_llm_error(err, False)
                if error.status == "aborted":
                    raise error from None
                if self._o.on_hop_failed is not None:
                    self._o.on_hop_failed(LlmRoute(provider=hop.provider, model=hop.model), error)
                last = error
                if not should_fall_back(error.status) and error.status != "empty":
                    raise error from None
                if i + 1 < len(hops):
                    nxt = hops[i + 1]
                    if request.on_fallback is not None:
                        request.on_fallback(LlmRoute(provider=nxt.provider, model=nxt.model))
        raise last or LlmError("no LLM route configured", None)


def create_llm_router(
    *,
    hops: Sequence[LlmHop],
    ttft_timeout_ms: float = 5_000,
    max_tokens: int = 400,
    temperature: float = 0.3,
    now: Callable[[], float] | None = None,
    on_hop_failed: Callable[[LlmRoute, LlmError], None] | None = None,
) -> LlmClient:
    options = LlmRouterOptions(
        hops=hops,
        ttft_timeout_ms=ttft_timeout_ms,
        max_tokens=max_tokens,
        temperature=temperature,
        on_hop_failed=on_hop_failed,
    )
    if now is not None:
        options.now = now
    return LlmRouter(options)

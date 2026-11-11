"""The LLM router (P5-T06): REAL Groq and Gemini streams captured in P5-T01 replayed through agent/llm.py with a fake SDK
client, and the fallback chain (D06) with scripted failures."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest

from app.agent.llm import LlmHop, create_llm_router, should_fall_back, to_openai_messages
from app.agent.tools import TOOLS
from app.voice.types import AbortSignal, ChatToolCall, LlmChunk, LlmError, LlmMessage, ToolCallChunk, UsageChunk

FIXTURE = json.loads((Path(__file__).parent.parent / "fixtures" / "providers" / "llm-streams.json").read_text())


class FakeClient:
    """A fake SDK client: each create() replays a script (raw chunks, an error, or a stall)."""

    def __init__(self, *scripts: dict[str, Any]) -> None:
        self.calls: list[dict[str, Any]] = []
        self._scripts = list(scripts)
        self.chat = self
        self.completions = self

    async def create(self, **params: Any) -> AsyncIterator[dict[str, Any]]:
        self.calls.append(params)
        if not self._scripts:
            raise RuntimeError("no script")
        script = self._scripts.pop(0)
        if "error" in script:
            raise script["error"]
        return self._replay(script)

    @staticmethod
    async def _replay(script: dict[str, Any]) -> AsyncIterator[dict[str, Any]]:
        if script.get("stall"):
            await asyncio.Event().wait()  # until the router cancels it
            return
        for chunk in script["raw"]:
            yield chunk


def last_usage(raw: list[dict[str, Any]]) -> dict[str, int]:
    """The usage a stream reported last (the total): what the router must emit, once."""
    usage = [r["usage"] for r in raw if r.get("usage")][-1]
    cached = (usage.get("prompt_tokens_details") or {}).get("cached_tokens") or 0
    return {
        "prompt_tokens": usage["prompt_tokens"],
        "completion_tokens": usage["completion_tokens"],
        "cached_tokens": cached,
    }


def hop(client: FakeClient, provider: str = "groq", model: str = "openai/gpt-oss-20b") -> LlmHop:
    return LlmHop(
        provider=provider, model=model, client=client, extra={"reasoning_effort": "low"} if provider == "groq" else {}
    )


async def collect(stream: Any) -> list[LlmChunk]:
    return [chunk async for chunk in stream]


MESSAGES = [LlmMessage(role="system", content="s"), LlmMessage(role="user", content="hi")]


def request(**extra: Any):
    from app.voice.types import LlmRequest

    return LlmRequest(messages=MESSAGES, tools=list(TOOLS), **extra)


class TestRealStreamsReplayedThroughTheRouter:
    async def test_groq_a_tool_call_assembled_from_deltas_and_the_usage_reported_once(self) -> None:
        raw = FIXTURE["groq"]["turn"]["raw"]
        client = FakeClient({"raw": raw})
        stream = await create_llm_router(hops=[hop(client)]).stream(request())
        chunks = await collect(stream)
        assert [c.type for c in chunks] == ["toolCall", "usage", "done"]
        assert isinstance(chunks[0], ToolCallChunk)
        call = chunks[0].call
        assert call.name == "save_field"
        args = json.loads(call.arguments)
        assert args["field"] == "deviceType" and args["value"] == "smartphone"
        assert len([r for r in raw if r.get("usage")]) >= 1
        expected = last_usage(raw)
        assert isinstance(chunks[1], UsageChunk)
        assert (chunks[1].usage.prompt_tokens, chunks[1].usage.completion_tokens, chunks[1].usage.cached_tokens) == (
            expected["prompt_tokens"],
            expected["completion_tokens"],
            expected["cached_tokens"],
        )
        assert (stream.route.provider, stream.route.model) == ("groq", "openai/gpt-oss-20b")
        assert stream.ttft_ms is not None
        # What was sent: the D06 parameters.
        sent = client.calls[0]
        assert sent["model"] == "openai/gpt-oss-20b" and sent["tool_choice"] == "auto" and sent["stream"] is True
        assert sent["stream_options"] == {"include_usage": True} and sent["reasoning_effort"] == "low"
        assert len(sent["tools"]) == len(TOOLS)

    async def test_gemini_text_and_three_calls_index_0_reused_a_new_id_starts_a_new_call_thought_signature_kept_and_echoed(
        self,
    ) -> None:
        raw = FIXTURE["gemini"]["turn"]["raw"]
        client = FakeClient({"raw": raw})
        chunks = await collect(
            await create_llm_router(hops=[hop(client, "gemini", "gemini-flash-lite-latest")]).stream(request())
        )
        calls = [c.call for c in chunks if isinstance(c, ToolCallChunk)]
        assert [json.loads(c.arguments)["field"] for c in calls] == ["deviceType", "deviceModel", "problemDescription"]
        assert len({c.id for c in calls}) == 3
        assert calls[0].extra == {"google": {"thought_signature": "<redacted signature>"}}
        # Gemini reports usage on several chunks, cumulatively: one usage chunk out, the latest.
        assert len([r for r in raw if r.get("usage")]) > 1
        usages = [c for c in chunks if isinstance(c, UsageChunk)]
        assert len(usages) == 1
        expected = last_usage(raw)
        assert usages[0].usage.prompt_tokens == expected["prompt_tokens"]
        assert usages[0].usage.completion_tokens == expected["completion_tokens"]
        assert usages[0].usage.cached_tokens == expected["cached_tokens"]
        # The follow-up request echoes it back (P0-T03: without it Gemini answers 400). The real follow-up succeeded.
        echoed = to_openai_messages([LlmMessage(role="assistant", content=None, tool_calls=list(calls))])
        assert echoed[0]["tool_calls"][0]["extra_content"] == calls[0].extra
        assert len(FIXTURE["gemini"]["followUp"]["raw"]) > 0


def status(code: int) -> Exception:
    error = Exception(f"HTTP {code}")
    error.status = code  # type: ignore[attr-defined]
    return error


class TestFallbackChain:
    async def test_a_429_from_the_primary_is_answered_by_the_next_route_within_the_same_turn(self) -> None:
        failed: list[Any] = []
        primary = FakeClient({"error": status(429)})
        second = FakeClient({"raw": FIXTURE["groq"]["turn"]["raw"]})
        router = create_llm_router(
            hops=[hop(primary), hop(second, "groq", "openai/gpt-oss-120b")],
            on_hop_failed=lambda route, error: failed.append((route.model, error.status)),
        )
        stream = await router.stream(request())
        assert stream.route.model == "openai/gpt-oss-120b"
        assert any(isinstance(c, ToolCallChunk) for c in await collect(stream))
        assert failed == [("openai/gpt-oss-20b", 429)]

    @pytest.mark.parametrize("first", ["503", "network", "stall", "empty"])
    async def test_5xx_a_network_error_no_first_output_within_the_ttft_timeout_and_empty_output_all_move_on(
        self, first: str
    ) -> None:
        script = {
            "503": {"error": status(503)},
            "network": {"error": Exception("ECONNRESET")},
            "stall": {"stall": True},
            "empty": {"raw": []},
        }[first]
        router = create_llm_router(
            ttft_timeout_ms=50,
            hops=[
                hop(FakeClient(script)),
                hop(FakeClient({"raw": FIXTURE["groq"]["turn"]["raw"]}), "gemini", "gemini-flash-lite-latest"),
            ],
        )
        assert (await router.stream(request())).route.provider == "gemini"

    async def test_a_400_does_not_move_on(self) -> None:
        router = create_llm_router(
            hops=[hop(FakeClient({"error": status(400)})), hop(FakeClient({"raw": FIXTURE["groq"]["turn"]["raw"]}))]
        )
        with pytest.raises(LlmError) as info:
            await router.stream(request())
        assert info.value.status == 400

    async def test_every_route_failing_raises_the_last_error_an_abort_stops_the_chain(self) -> None:
        router = create_llm_router(
            hops=[hop(FakeClient({"error": status(429)})), hop(FakeClient({"error": status(500)}))]
        )
        with pytest.raises(LlmError) as info:
            await router.stream(request())
        assert info.value.status == 500
        signal = AbortSignal()
        signal.abort()
        with pytest.raises(LlmError) as aborted:
            await create_llm_router(hops=[hop(FakeClient({"raw": []}))]).stream(request(signal=signal))
        assert aborted.value.status == "aborted"
        assert (
            should_fall_back(429) and should_fall_back(502) and should_fall_back("timeout") and should_fall_back(None)
        )
        assert not (should_fall_back(400) or should_fall_back(401))
        assert LlmError("x", "empty").status == "empty"

    async def test_an_abort_while_the_stream_is_being_read_ends_it_with_an_aborted_error(self) -> None:
        signal = AbortSignal()

        async def slow() -> AsyncIterator[dict[str, Any]]:
            yield {"choices": [{"delta": {"content": "Hello. "}}]}
            await asyncio.Event().wait()

        class Client(FakeClient):
            async def create(self, **params: Any) -> AsyncIterator[dict[str, Any]]:
                return slow()

        stream = await create_llm_router(hops=[hop(Client())]).stream(request(signal=signal))
        seen: list[LlmChunk] = []
        with pytest.raises(LlmError) as info:
            async for chunk in stream:
                seen.append(chunk)
                signal.abort()
        assert info.value.status == "aborted"
        assert seen and seen[0].type == "text"


def test_to_openai_messages_maps_every_role() -> None:
    call = ChatToolCall(id="c1", name="end_call", arguments="{}")
    out = to_openai_messages(
        [
            LlmMessage(role="system", content="s"),
            LlmMessage(role="user", content="u"),
            LlmMessage(role="assistant", content=None, tool_calls=[call]),
            LlmMessage(role="tool", tool_call_id="c1", content="{}"),
        ]
    )
    assert out == [
        {"role": "system", "content": "s"},
        {"role": "user", "content": "u"},
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "end_call", "arguments": "{}"}}],
        },
        {"role": "tool", "tool_call_id": "c1", "content": "{}"},
    ]

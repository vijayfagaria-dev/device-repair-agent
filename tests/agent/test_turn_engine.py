"""The turn engine (P5-T06) with the scripted fake LLM and a recording tool runner.

Text only; text + a valid tool; tools only -> acknowledge-then-ask; an invalid result -> a follow-up; malformed tool JSON;
the last-resort route; every route failing; tools run exactly once; the round limit; abort.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field

from app.agent.tools import ParsedToolCall
from app.agent.turn_engine import (
    FILLER_LINE,
    MAX_ROUNDS,
    ONE_MOMENT,
    ToolOutcome,
    TurnDeps,
    TurnInput,
    TurnOutput,
    run_turn,
)
from app.voice.fakes.llm import FakeLlm, LlmScript
from app.voice.types import AbortSignal, LlmError, LlmMessage, LlmRoute


def _default_outcome(call: ParsedToolCall) -> ToolOutcome:
    return ToolOutcome(result={"status": "valid"}, ok=True, ack="Got it.")


class Sink:
    def __init__(self, said: list[str]) -> None:
        self.said = said

    def say(self, text: str) -> None:
        self.said.append(text)

    def break_chunk(self) -> None:
        pass


@dataclass
class Setup:
    outcome: Callable[[ParsedToolCall], ToolOutcome] = _default_outcome
    llm: FakeLlm = field(default_factory=FakeLlm)
    ran: list[ParsedToolCall] = field(default_factory=list)
    said: list[str] = field(default_factory=list)
    states: int = 0

    async def run_tool(self, call: ParsedToolCall) -> ToolOutcome:
        self.ran.append(call)
        return self.outcome(call)

    async def state(self) -> LlmMessage:
        self.states += 1
        return LlmMessage(role="system", content=f"STATE {self.states}")

    async def go(
        self, signal: AbortSignal | None = None, is_stale: Callable[[], bool] | None = None, fixed_state: bool = False
    ) -> TurnOutput:
        async def fixed() -> LlmMessage:
            return LlmMessage(role="system", content="STATE")

        return await run_turn(
            TurnDeps(llm=self.llm, tools=self),  # type: ignore[arg-type]
            TurnInput(
                history=[LlmMessage(role="system", content="prompt"), LlmMessage(role="user", content="hi")],
                state=fixed if fixed_state else self.state,
                signal=signal,
                is_stale=is_stale,
            ),
            Sink(self.said),
        )

    # ToolRunner protocol
    async def run(self, call: ParsedToolCall) -> ToolOutcome:
        return await self.run_tool(call)


def save(field_: str, value: str) -> dict:
    return {"name": "save_field", "args": {"field": field_, "value": value, "spoken_evidence": value}}


class TestRunTurn:
    async def test_text_only_streamed_in_order_one_model_call_recorded_as_the_agents_message(self) -> None:
        t = Setup()
        t.llm.enqueue(LlmScript(text="Hi! I'm Riya. What device is it?", piece_chars=5))
        out = await t.go()
        assert "".join(t.said) == "Hi! I'm Riya. What device is it?"
        assert len(t.said) > 3
        assert out.spoken == "Hi! I'm Riya. What device is it?"
        assert out.failed is False and out.end_call is False
        assert out.rounds[0].route.provider == "groq"
        assert out.messages == [LlmMessage(role="assistant", content="Hi! I'm Riya. What device is it?")]
        assert len(t.llm.requests) == 1
        assert t.llm.requests[0].messages[-1].content == "STATE 1"  # state last

    async def test_text_plus_a_valid_tool_runs_once_and_no_follow_up(self) -> None:
        t = Setup()
        t.llm.enqueue(
            LlmScript(
                text="Got it, a Samsung. When did it start?", tool_calls=[save("deviceModel", "Samsung Galaxy S23")]
            )
        )
        out = await t.go()
        assert [c.name for c in t.ran] == ["save_field"]
        assert len(t.llm.requests) == 1
        assert [m.role for m in out.messages] == ["assistant", "tool"]
        assert out.messages[1].content == json.dumps({"status": "valid"}, separators=(",", ":"))

    async def test_tools_only_acknowledges_at_once_then_the_follow_up_asks_the_next_question(self) -> None:
        def outcome(call: ParsedToolCall) -> ToolOutcome:
            ack = (
                "Got it, Samsung Galaxy S23."
                if call.name == "save_field" and call.args["field"] == "deviceModel"
                else "Got it."
            )
            return ToolOutcome(result={"status": "valid"}, ok=True, ack=ack)

        t = Setup(outcome=outcome)
        t.llm.enqueue(
            LlmScript(tool_calls=[save("deviceModel", "Samsung Galaxy S23")]),
            LlmScript(text="When did the problem start?"),
        )
        out = await t.go()
        assert t.said == ["Got it, Samsung Galaxy S23.", " When did the problem start?"]
        assert out.spoken == "Got it, Samsung Galaxy S23. When did the problem start?"
        assert len(t.llm.requests) == 2
        # The acknowledgement is in the history as the agent's words, before the tool results.
        assert out.messages[0].role == "assistant" and out.messages[0].content == "Got it, Samsung Galaxy S23."
        assert t.states == 2  # a fresh state for the follow-up

    async def test_one_field_per_call_several_rounds_each_acknowledged_once_until_the_model_speaks(self) -> None:
        t = Setup(
            outcome=lambda call: ToolOutcome(result={"status": "valid"}, ok=True, ack=f"Noted {call.args['field']}.")
        )
        t.llm.enqueue(
            LlmScript(tool_calls=[save("deviceType", "smartphone")]),
            LlmScript(tool_calls=[save("deviceModel", "Samsung Galaxy S23")]),
            LlmScript(text="What's wrong with it?"),
        )
        out = await t.go()
        assert len(t.ran) == 2
        assert out.spoken == "Noted deviceType. Noted deviceModel. What's wrong with it?"

    async def test_an_invalid_result_no_acknowledgement_and_a_follow_up_so_the_agent_can_ask_again(self) -> None:
        t = Setup(
            outcome=lambda call: ToolOutcome(
                result={"status": "invalid", "error": "That date is in the future."}, ok=False
            )
        )
        t.llm.enqueue(
            LlmScript(tool_calls=[save("problemStartedAt", "tomorrow")]), LlmScript(text="Sorry, when did it start?")
        )
        out = await t.go()
        assert out.spoken == "Sorry, when did it start?"
        assert len(t.llm.requests) == 2
        assert out.messages[1].role == "tool"
        assert out.messages[1].content == json.dumps(
            {"status": "invalid", "error": "That date is in the future."}, separators=(",", ":")
        )

    async def test_malformed_tool_json_or_an_unknown_tool_gets_an_error_result_no_effect_and_a_follow_up(self) -> None:
        t = Setup()
        t.llm.enqueue(
            LlmScript(tool_calls=[{"name": "save_field", "args": "{broken"}, {"name": "launch_rocket", "args": {}}]),
            LlmScript(text="Could you repeat that?"),
        )
        out = await t.go()
        assert t.ran == []
        statuses = [json.loads(m.content or "{}")["status"] for m in out.messages if m.role == "tool"]
        assert statuses == ["error", "error"]
        assert out.spoken == "Could you repeat that?"

    async def test_each_tool_runs_exactly_once_even_across_rounds(self) -> None:
        t = Setup()
        t.llm.enqueue(
            LlmScript(
                tool_calls=[
                    save("deviceType", "laptop"),
                    {"name": "request_chat_input", "args": {"field": "serialNumber"}},
                ]
            ),
            LlmScript(text="Anything else?"),
        )
        await t.go()
        assert [c.name for c in t.ran] == ["save_field", "request_chat_input"]

    async def test_falling_back_to_the_last_resort_says_one_moment_while_it_works_other_routes_dont(self) -> None:
        t = Setup()
        t.llm.enqueue(
            LlmScript(
                text="Which model is it?",
                route=LlmRoute(provider="gemini", model="gemini-flash-lite-latest"),
                fell_back=True,
            )
        )
        assert (await t.go()).spoken == f"{ONE_MOMENT} Which model is it?"
        t.llm.enqueue(
            LlmScript(
                text="Which model is it?", route=LlmRoute(provider="groq", model="openai/gpt-oss-120b"), fell_back=True
            )
        )
        assert (await t.go()).spoken == "Which model is it?"

    async def test_every_route_failing_the_filler_line_marked_failed_empty_output_also_counts_as_refused(self) -> None:
        t = Setup()
        t.llm.enqueue(LlmScript(error=LlmError("all routes failed", 503)))
        out = await t.go()
        assert (out.spoken, out.failed, out.refused) == (FILLER_LINE, True, False)
        t.llm.enqueue(LlmScript(error=LlmError("empty", "empty")))
        out = await t.go()
        assert out.failed is True and out.refused is True

    async def test_end_call_ends_the_turn_no_follow_up(self) -> None:
        t = Setup(
            outcome=lambda call: ToolOutcome(result={"status": "ending"}, ok=True, end_call=call.name == "end_call")
        )
        t.llm.enqueue(
            LlmScript(text="Thanks, goodbye!", tool_calls=[{"name": "end_call", "args": {}}]),
            LlmScript(text="should not run"),
        )
        out = await t.go()
        assert out.end_call is True
        assert len(t.llm.requests) == 1

    async def test_stops_after_max_rounds_model_calls_even_if_the_model_never_speaks(self) -> None:
        t = Setup(outcome=lambda call: ToolOutcome(result={"status": "valid"}, ok=True))
        for _ in range(MAX_ROUNDS + 2):
            t.llm.enqueue(LlmScript(tool_calls=[save("deviceType", "laptop")]))
        await t.go()
        assert len(t.llm.requests) == MAX_ROUNDS

    async def test_an_abort_barge_in_stops_mid_stream_and_keeps_only_what_was_streamed(self) -> None:
        t = Setup()
        signal = AbortSignal()
        n = 0

        async def gate() -> None:
            nonlocal n
            n += 1
            if n == 2:
                signal.abort()

        t.llm.enqueue(LlmScript(text="One. Two. Three. Four.", piece_chars=5, gate=gate))
        out = await t.go(signal)
        assert out.aborted is True
        assert out.spoken == "One. "


class TestNoDoubleAcknowledgement:
    """Seen in a real gpt-oss-20b call."""

    async def test_a_follow_up_that_repeats_the_spoken_acknowledgement_has_that_part_dropped_even_split_across_pieces(
        self,
    ) -> None:
        t = Setup()
        t.llm.enqueue(
            LlmScript(tool_calls=[save("deviceType", "smartphone")]),
            LlmScript(text="Got it. Could you tell me the brand and model?", piece_chars=3),
        )
        out = await t.go()
        assert out.spoken == "Got it. Could you tell me the brand and model?"
        assert "".join(t.said) == "Got it. Could you tell me the brand and model?"
        assert [m.content for m in out.messages if m.role == "assistant"] == [
            "Got it.",
            "Could you tell me the brand and model?",
        ]

    async def test_a_follow_up_that_only_starts_the_same_way_is_spoken_in_full(self) -> None:
        t = Setup()
        t.llm.enqueue(
            LlmScript(tool_calls=[save("deviceType", "smartphone")]),
            LlmScript(text="Got itchy fingers? Which model is it?", piece_chars=4),
        )
        out = await t.go()
        assert out.spoken == "Got it. Got itchy fingers? Which model is it?"

    async def test_nothing_the_model_says_is_cut_a_reply_with_a_question_and_more_after_it_is_spoken_in_full(
        self,
    ) -> None:
        t = Setup()
        t.llm.enqueue(LlmScript(text="What seems to be wrong with it? Take your time, I'm listening.", piece_chars=7))
        out = await t.go()
        assert out.spoken == "What seems to be wrong with it? Take your time, I'm listening."

    async def test_after_the_model_asked_something_a_failed_tool_call_does_not_start_a_follow_up_that_asks_again(
        self,
    ) -> None:
        t = Setup(outcome=lambda call: ToolOutcome(result={"status": "invalid", "error": "which date?"}, ok=False))
        t.llm.enqueue(
            LlmScript(text="When did it start?", tool_calls=[save("problemStartedAt", "soon")]),
            LlmScript(text="Could you tell me when it started?"),
        )
        out = await t.go()
        assert out.spoken == "When did it start?"
        assert len(t.llm.requests) == 1

    # Live (2026-11-11 22:55): "I've sent a card in the chat for you to type in your serial number" was said after the
    # customer had typed it: text written from a state that went stale while the model was generating.
    async def test_model_text_written_from_a_stale_state_is_not_spoken_and_no_follow_up_round_runs(self) -> None:
        t = Setup()
        stale = False

        async def gate() -> None:
            nonlocal stale
            stale = True

        t.llm.enqueue(
            LlmScript(text="Please type your serial number in the chat.", piece_chars=10, gate=gate),
            LlmScript(text="Anything else?"),
        )
        out = await t.go(is_stale=lambda: stale, fixed_state=True)
        assert out.spoken == ""
        assert len(t.llm.requests) == 1

    async def test_an_acknowledgement_built_from_validated_results_is_still_spoken_when_the_state_went_stale(
        self,
    ) -> None:
        t = Setup(outcome=lambda call: ToolOutcome(result={"status": "valid"}, ok=True, ack="Got it."))
        t.llm.enqueue(LlmScript(tool_calls=[save("deviceType", "smartphone")]))
        out = await t.go(is_stale=lambda: True, fixed_state=True)
        assert out.spoken == "Got it."
        assert len(t.llm.requests) == 1


class TestBrokenStream:
    """Live call of 2026-11-11: a connection that dies mid-reply gets one more round, told where it was cut off."""

    async def test_a_stream_that_breaks_after_some_text_is_retried_once_with_a_hint_and_never_leaves_the_line_silent(
        self,
    ) -> None:
        t = Setup()
        t.llm.enqueue(
            LlmScript(text="Sure, what is the", piece_chars=6, break_after=2), LlmScript(text="model of the phone?")
        )
        out = await t.go(fixed_state=True)
        assert out.failed is False
        assert out.spoken.startswith("Sure, what")
        assert len(t.llm.requests) == 2
        hint = t.llm.requests[1].messages[-2]
        assert hint.role == "system" and "cut off after" in (hint.content or "")

    async def test_a_stream_that_breaks_before_any_text_is_retried_once(self) -> None:
        t = Setup()
        t.llm.enqueue(LlmScript(text="Hello there.", break_after=0), LlmScript(text="Which device is it?"))
        out = await t.go(fixed_state=True)
        assert out.spoken == "Which device is it?"
        assert len(t.llm.requests) == 2

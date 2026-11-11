"""The call engine (P5-T07...T12) on fakes: a fake session port, fake STT/TTS/LLM and a manual clock.

Real time never passes, so timings (barge-in reaction, silence at 8/16/24 s, the proactive turn after 1.2 s) are exact.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import pytest

from app.agent.turn_engine import FILLER_LINE
from app.agent.voice_templates import OPTED_OUT_GOODBYE, PROVIDER_TROUBLE, REPROMPTS
from app.domain.fields import RECORD_FIELD_IDS
from app.protocol.enums import Role
from app.protocol.session import CloseCode
from app.protocol.types import AudioMessage, StopPlaybackMessage, TranscriptMessage
from app.voice.call_engine import CallEngine, CallTimings
from app.voice.call_session import CallContext
from app.voice.clock import ManualClock, settle_loop
from app.voice.fakes.llm import FakeLlm, LlmScript
from app.voice.fakes.stt import FakeStt
from app.voice.fakes.tts import FakeTts, FakeTtsOptions
from app.voice.speech_out import CallMessage
from app.voice.types import LlmError, SttError, SttSpeechStarted, SttTranscript, SttUtteranceEnd
from tests.domain.helpers import resolved


class NullLog:
    def __getattr__(self, name: str) -> Callable[..., None]:
        return lambda *args, **kwargs: None


Cmd = dict[str, Any]


class FakePort:
    session_id = "0b6f4c1e-3d2a-4e8b-9a71-5c2d8e9f1a3b"

    def __init__(self) -> None:
        self.commands: list[Cmd] = []
        self.llm_usage: list[Any] = []
        self.llm_requests: list[Any] = []
        self.metrics: list[dict[str, Any]] = []
        self.stt_seconds: list[float] = []
        self.tts_characters = 0
        self.reconciles = 0
        self._listeners: list[Callable[[Any], None]] = []
        self.ctx = CallContext(
            session=SimpleNamespace(status="active", outcome=None),  # type: ignore[arg-type]
            fields={i: resolved("missing") for i in RECORD_FIELD_IDS},
            requests=[],
            last_agent_line_before=None,
        )
        self.replies: dict[str, Callable[[Cmd], Any]] = {
            "SaveSpokenField": lambda c: {
                "status": "valid",
                "normalized": {"brand": "Samsung", "model": "Galaxy S23"}
                if c["field"] == "deviceModel"
                else c["value"],
            },
            "RequestInput": lambda c: {"status": "queued", "requestId": f"req_{c['field']}_1"},
            "EndCall": lambda c: {"status": "ended", "seconds": 1},
            "OptOutByCall": lambda c: {"status": "optedOut", "revision": 1},
        }

    async def dispatch(self, command: Cmd) -> Any:
        self.commands.append(command)
        reply = self.replies.get(command["type"])
        return reply(command) if reply else None

    async def context(self, call_id: str) -> CallContext:
        return self.ctx

    def subscribe(self, listener: Callable[[Any], None]) -> Callable[[], None]:
        self._listeners.append(listener)
        return lambda: self._listeners.remove(listener) if listener in self._listeners else None

    async def reconcile(self) -> None:
        self.reconciles += 1

    async def record_llm_usage(self, route: Any, usage: Any) -> None:
        self.llm_usage.append((route, usage))

    async def record_llm_request(self, route: Any) -> None:
        self.llm_requests.append(route)

    async def record_stt_seconds(self, seconds: float) -> None:
        self.stt_seconds.append(seconds)

    async def record_tts_characters(self, n: int) -> None:
        self.tts_characters += n

    async def record_turn_metric(self, metric: dict[str, Any]) -> None:
        self.metrics.append(metric)

    def emit(self, *events: dict[str, Any]) -> None:
        update = SimpleNamespace(
            session_id=self.session_id,
            events=[
                SimpleNamespace(
                    **{
                        "session_id": self.session_id,
                        "seq": 100 + i,
                        "channel": "chat",
                        "payload": {},
                        "created_at": datetime.now(UTC),
                        **e,
                    }
                )
                for i, e in enumerate(events)
            ],
        )
        for listener in list(self._listeners):
            listener(update)

    def of(self, type_: str) -> list[Cmd]:
        return [c for c in self.commands if c["type"] == type_]


@dataclass
class Call:
    clock: ManualClock
    stt: FakeStt
    tts: FakeTts
    llm: FakeLlm
    port: FakePort
    sent: list[CallMessage]
    closes: list[tuple[int, str]]
    engine: CallEngine

    async def step(self, ms: float, every: float = 20) -> None:
        """In small steps: TTS frames, the engine's timers and the async work between them interleave."""
        await self.clock.tick(ms, every=every, settle=30)


async def flush() -> None:
    await settle_loop(30)


async def call(
    *,
    fast_audio: bool = False,
    greeting: LlmScript | None = None,
    returning: bool = False,
    timings: CallTimings | None = None,
    timed_audio: bool = True,
) -> Call:
    clock = ManualClock()
    stt = FakeStt()
    # "Instant" speech: one 40 ms frame per chunk, so playback (which silence and barge-in follow) is short.
    tts = FakeTts(
        FakeTtsOptions(chars_per_frame=10_000)
        if not timed_audio
        else FakeTtsOptions(clock=clock, chars_per_frame=4, interval_ms=5 if fast_audio else None)
    )
    llm = FakeLlm()
    llm.fallback = LlmScript(text="Okay.")
    port = FakePort()
    sent: list[CallMessage] = []
    closes: list[tuple[int, str]] = []
    llm.enqueue(greeting or LlmScript(text="Hi, I'm Riya. What device is it?"))
    engine = await CallEngine.start(
        call_id="c1",
        port=port,  # type: ignore[arg-type]
        stt=stt,
        tts=tts,
        llm=llm,
        clock=clock,
        log=NullLog(),
        send=sent.append,
        close=lambda code, reason: closes.append((code, reason)),
        returning=returning,
        timings=timings,
    )
    c = Call(clock, stt, tts, llm, port, sent, closes, engine)
    await flush()
    return c


def last_state(llm: FakeLlm, index: int = -1) -> dict[str, Any]:
    content = llm.requests[index].messages[-1].content or ""
    return json.loads(content[len("STATE ") :])


def agent_lines(sent: list[CallMessage]) -> list[TranscriptMessage]:
    return [m for m in sent if isinstance(m, TranscriptMessage) and m.role == Role.AGENT]


def audio_count(sent: list[CallMessage]) -> int:
    return len([m for m in sent if isinstance(m, AudioMessage)])


def stop_playbacks(sent: list[CallMessage]) -> list[int]:
    return [i for i, m in enumerate(sent) if isinstance(m, StopPlaybackMessage)]


class TestTheCallStarts:
    async def test_greets_the_first_turn_runs_with_call_connected_the_agent_line_is_spoken_persisted_and_charged(
        self,
    ) -> None:
        c = await call()
        await c.step(3_000)
        first_user = next(m for m in c.llm.requests[0].messages if m.role == "user")
        assert first_user.content == "(The call has just connected.)"
        assert last_state(c.llm, 0)["isReturningCall"] is False and last_state(c.llm, 0)["claimStatus"] == "collecting"
        assert c.tts.current.spoken() == "Hi, I'm Riya. What device is it?"
        last = agent_lines(c.sent)[-1]
        assert (last.id, last.text, last.final) == ("ta_c1_1", "Hi, I'm Riya. What device is it?", True)
        assert [cmd["line"]["text"] for cmd in c.port.of("AppendTranscript")] == ["Hi, I'm Riya. What device is it?"]
        assert len(c.port.llm_usage) == 1
        route, usage = c.port.llm_usage[0]
        assert (route.provider, route.model) == ("groq", "openai/gpt-oss-20b")
        assert (usage.prompt_tokens, usage.completion_tokens, usage.cached_tokens) == (900, 20, 0)
        # Billed on what was sent to TTS: the two chunks (the space between them isn't sent).
        assert c.port.tts_characters == len("Hi, I'm Riya.") + len("What device is it?")
        await c.engine.stop("hangup")

    async def test_a_returning_call_the_first_turns_context_says_so_and_carries_whats_collected_whats_missing_and_the_last_question(
        self,
    ) -> None:
        c = await call(returning=True)
        c.port.ctx.last_agent_line_before = "And when did the problem start?"
        # The greeting's state was read already; check a fresh one on the next turn too.
        await c.step(2_000)
        first_user = next(m for m in c.llm.requests[0].messages if m.role == "user")
        assert first_user.content == "(The customer called back.)"
        assert last_state(c.llm, 0)["isReturningCall"] is True
        c.port.ctx.fields = {
            **c.port.ctx.fields,
            "deviceType": resolved("valid", "smartphone", "call"),
            "deviceModel": resolved("valid", {"brand": "Samsung", "model": "Galaxy S23"}, "call"),
        }
        c.stt.current.say("It started last week")
        await c.step(1_000)
        state = last_state(c.llm)
        assert state["isReturningCall"] is True
        assert state["lastQuestionOnPreviousCall"] == "And when did the problem start?"
        assert state["collected"]["deviceType"] == '<customer_words field="deviceType">Phone</customer_words>'
        assert (
            state["collected"]["deviceModel"]
            == '<customer_words field="deviceModel">Samsung Galaxy S23</customer_words>'
        )
        assert "deviceType" not in state["missing"]
        assert "problemStartedAt" in state["missing"]
        await c.engine.stop("hangup")


class TestAUserTurn:
    async def test_transcript_lines_with_one_id_per_utterance_only_the_final_persisted_the_agent_saves_the_field_and_acknowledges_it_then_asks(
        self,
    ) -> None:
        c = await call()
        await c.step(3_000)
        c.llm.enqueue(
            LlmScript(
                tool_calls=[
                    {
                        "name": "save_field",
                        "args": {
                            "field": "deviceModel",
                            "value": "Samsung Galaxy S23",
                            "spoken_evidence": "It's a Samsung Galaxy S23",
                        },
                    }
                ]
            ),
            LlmScript(text="What's wrong with it?"),
        )
        for _ in range(50):
            c.engine.push_audio(bytes(640))
        c.stt.current.say("It's a Samsung Galaxy S23")
        await c.step(300)  # merge window
        await c.step(4_000)
        user_lines = [m for m in c.sent if isinstance(m, TranscriptMessage) and m.role == Role.USER]
        assert {line.id for line in user_lines} == {"tu_c1_1"}
        assert user_lines[-1].text == "It's a Samsung Galaxy S23" and user_lines[-1].final is True
        assert len([cmd for cmd in c.port.of("AppendTranscript") if cmd["line"]["role"] == Role.USER]) == 1
        assert c.port.of("SaveSpokenField") == [
            {
                "type": "SaveSpokenField",
                "field": "deviceModel",
                "value": "Samsung Galaxy S23",
                "evidence": "It's a Samsung Galaxy S23",
            }
        ]
        assert c.tts.current.spoken("ta_c1_2") == "Got it, Samsung Galaxy S23. What's wrong with it?"
        metric = next(m for m in c.port.metrics if m["turn_id"] == "ta_c1_2")
        assert metric["call_id"] == "c1" and metric["llm_ttft_ms"] == 120
        assert isinstance(metric["server_ms"], int)
        await c.engine.stop("hangup")
        assert c.port.stt_seconds == [1]  # 50 frames of 20 ms

    async def test_every_reply_to_a_user_utterance_gets_a_latency_row_measured_from_stts_end_event(self) -> None:
        """P11-T02."""
        c = await call()
        await c.step(3_000)

        def rows() -> list[dict[str, Any]]:
            return [m for m in c.port.metrics if "user_end_at" in m]

        for n in range(6):
            c.llm.enqueue(LlmScript(text=f"Answer number {n}."))
            c.stt.current.say(f"my message number {n}")
            await c.step(300)  # the merge window after speech_final
            await c.step(4_000)
        assert len(rows()) == 6  # 6 replies after 6 utterances: 100% (the plan asks for >= 95%)
        for row in rows():
            user_end_at = row["user_end_at"].timestamp() * 1000
            first_audio_at = row["first_audio_at"].timestamp() * 1000
            assert row["stt_ms"] == 300  # speech_final -> the turn starts: the merge window
            assert row["server_ms"] == round(first_audio_at - user_end_at)
            assert row["server_ms"] >= 0
            assert isinstance(row["llm_ttft_ms"], int)
            assert isinstance(row["tts_ttfb_ms"], int)
        # The greeting follows no user utterance: it has audio but no user end, so no server_ms and no stt_ms.
        greeting = next(m for m in c.port.metrics if m["turn_id"] == "ta_c1_1")
        assert greeting["call_id"] == "c1"
        assert "server_ms" not in greeting
        await c.engine.stop("hangup")

    async def test_a_reply_the_model_failed_to_produce_still_gets_its_row_without_server_latency(self) -> None:
        """P11-T02."""
        c = await call()
        await c.step(3_000)
        c.llm.enqueue(LlmScript(error=LlmError("down", 503)))
        c.stt.current.say("my phone is broken")
        await c.step(300)
        await c.step(4_000)
        row = next((m for m in c.port.metrics if "user_end_at" in m), None)
        assert row is not None
        assert row["stt_ms"] == 300
        await c.engine.stop("hangup")

    async def test_an_identifier_said_aloud_is_saved_as_heard_only_and_its_chat_card_goes_out_at_once(self) -> None:
        """D13."""
        c = await call()
        await c.step(3_000)
        c.port.replies["SaveSpokenField"] = lambda cmd: {"status": "unverified", "normalized": "asha@example.com"}
        c.llm.enqueue(
            LlmScript(
                tool_calls=[
                    {
                        "name": "save_field",
                        "args": {
                            "field": "email",
                            "value": "asha@example.com",
                            "spoken_evidence": "asha at example dot com",
                        },
                    }
                ]
            ),
            LlmScript(text="Thanks."),
        )
        c.stt.current.say("my email is asha at example dot com")
        await c.step(3_000)
        assert c.port.of("RequestInput") == [{"type": "RequestInput", "field": "email"}]
        assert "Please type your email address in the chat box" in c.tts.current.spoken("ta_c1_2")
        await c.engine.stop("hangup")


LONG = "Thanks for calling the repair desk. I can help you register your claim today, and it only takes a few minutes. First, which device is it?"


class TestBargeIn:
    """P5-T07."""

    async def test_confirmed_speech_while_the_agent_is_audible_stopplayback_first_then_no_more_audio_tts_cancelled_once_the_line_cut_at_what_was_heard(
        self,
    ) -> None:
        c = await call(greeting=LlmScript(text=LONG))
        await c.step(600)  # the agent has been audible for a while
        audio_before = audio_count(c.sent)
        assert audio_before > 3
        c.stt.current.emit(SttSpeechStarted())
        c.stt.current.emit(SttTranscript(text="wait sorry", is_final=False, speech_final=False))
        # The reaction happens in the same tick as the confirming event (<= 50 ms: here 0 ms of clock time).
        stop_at = stop_playbacks(c.sent)
        assert len(stop_at) == 1 and stop_at[0] > 0
        await c.step(3_000)
        assert audio_count(c.sent[stop_at[0] + 1 :]) == 0
        assert c.tts.current.cancelled_turns == ["ta_c1_1"]
        assert c.engine.barge_ins == 1
        final = [line for line in agent_lines(c.sent) if line.final][-1]
        assert final.text.endswith("[interrupted]")
        persisted = next(cmd["line"] for cmd in c.port.of("AppendTranscript") if cmd["line"]["role"] == Role.AGENT)
        assert persisted["interrupted"] is True
        assert LONG.startswith(persisted["text"].replace(" [interrupted]", ""))
        assert len(persisted["text"]) < len(LONG)
        await c.engine.stop("hangup")

    async def test_the_interrupted_line_is_what_the_model_sees_next_turn_and_the_llm_stream_was_aborted(self) -> None:
        gate: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        pieces = 0

        async def hold() -> None:
            nonlocal pieces
            pieces += 1
            if pieces > 2:
                await gate

        c = await call(greeting=LlmScript(text=LONG, piece_chars=30, gate=hold))
        await c.step(600)
        c.stt.current.emit(SttSpeechStarted())
        c.stt.current.emit(SttTranscript(text="hold on please", is_final=True, speech_final=True))
        gate.set_result(None)
        await c.step(400)
        await c.step(2_000)
        nxt = c.llm.requests[-1].messages
        assistant = [m for m in nxt if m.role == "assistant"][-1]
        assert str(assistant.content).endswith("[interrupted]")
        assert [m for m in nxt if m.role == "user"][-1].content == "hold on please"
        assert len(c.tts.current.spoken("ta_c1_1")) < len(LONG)  # the rest was never sent to TTS
        await c.engine.stop("hangup")

    async def test_echo_or_a_cough_doesnt_interrupt_voice_activity_alone_or_one_short_word(self) -> None:
        c = await call(greeting=LlmScript(text=f"{LONG} {LONG}"))  # long enough to still be speaking throughout
        await c.step(600)
        c.stt.current.emit(SttSpeechStarted())
        await c.step(1_000)
        c.stt.current.emit(SttUtteranceEnd())
        c.stt.current.emit(SttSpeechStarted())
        c.stt.current.emit(SttTranscript(text="uh", is_final=False, speech_final=False))
        await c.step(200)
        assert stop_playbacks(c.sent) == []
        # ...but one word that goes on for 400 ms does.
        await c.step(300)
        assert len(stop_playbacks(c.sent)) > 0
        await c.engine.stop("hangup")

    async def test_speech_in_the_first_250_ms_of_the_agents_audio_is_ignored(self) -> None:
        c = await call(greeting=LlmScript(text=LONG))
        await c.step(100)
        c.stt.current.emit(SttSpeechStarted())
        c.stt.current.emit(SttTranscript(text="two words", is_final=False, speech_final=False))
        assert stop_playbacks(c.sent) == []
        await c.engine.stop("hangup")


class TestPlaybackNotSendingIsWhatCounts:
    """Found by the real-provider call."""

    async def test_audio_sent_8x_faster_than_real_time_after_the_last_frame_is_sent_the_user_still_hears_it_so_barge_in_still_works(
        self,
    ) -> None:
        c = await call(greeting=LlmScript(text=LONG), fast_audio=True)
        await c.step(
            800
        )  # every frame has been sent (the fake sends a 40 ms frame every 5 ms), but only the first sentence is playing...
        assert [m for m in agent_lines(c.sent) if m.final] == []  # ...so the line is not final yet
        c.stt.current.emit(SttSpeechStarted())
        c.stt.current.emit(SttTranscript(text="hang on", is_final=False, speech_final=False))
        assert len(stop_playbacks(c.sent)) > 0
        # The line is closed in place (same id) at what was heard.
        lines = [m for m in agent_lines(c.sent) if m.id == "ta_c1_1" and m.final]
        assert len(lines) == 1
        assert lines[0].text.endswith("[interrupted]")
        await c.step(500)
        persisted = next(cmd["line"] for cmd in c.port.of("AppendTranscript") if cmd["line"]["role"] == Role.AGENT)
        assert persisted["interrupted"] is True
        await c.engine.stop("hangup")

    # User report (2026-11-11): "text and voice are not matching in order". The transcript showed a whole reply while the
    # voice was still on its first sentence; now each sentence appears when its audio starts playing.
    async def test_the_transcript_grows_sentence_by_sentence_as_the_voice_reaches_each_one_and_is_final_after_the_last_starts(
        self,
    ) -> None:
        c = await call(greeting=LlmScript(text=LONG), fast_audio=True)
        await c.step(800)  # all audio sent, ~1 s of it playing
        early = agent_lines(c.sent)
        assert len(early) > 0
        assert all(not m.final for m in early)
        assert (
            early[-1].text
            == "Thanks for calling the repair desk. I can help you register your claim today, and it only takes a few minutes."
        )
        await c.step(6_000)  # played out
        everything = agent_lines(c.sent)
        assert everything[-1].final is True and everything[-1].text == LONG
        # Each message extends the previous one: never out of order, never shorter.
        for i in range(1, len(everything)):
            assert everything[i].text.startswith(everything[i - 1].text)
        await c.engine.stop("hangup")

    async def test_end_call_waits_until_the_goodbye_has_played_not_just_been_sent(self) -> None:
        c = await call(greeting=LlmScript(text=LONG, tool_calls=[{"name": "end_call", "args": {}}]), fast_audio=True)
        await c.step(1_000)  # all sent; about 5 s of audio still to play
        assert c.port.of("EndCall") == []
        await c.step(6_000)
        assert c.port.of("EndCall") == [{"type": "EndCall", "call_id": "c1", "reason": "agent_ended"}]


def accepted(field: str) -> dict[str, Any]:
    return {"type": "field.candidate", "payload": {"candidate": {"field": field, "status": "valid"}}}


class TestChatEventsOnTheCall:
    """P5-T08."""

    async def test_an_event_while_idle_a_proactive_turn_at_most_1_5_s_after_the_idle_threshold_with_the_event_in_its_state(
        self,
    ) -> None:
        c = await call(timed_audio=False)
        await c.step(100)
        before = len(c.llm.requests)
        c.port.emit(accepted("email"))
        await c.step(1_100)
        assert len(c.llm.requests) == before
        await c.step(200)
        assert len(c.llm.requests) == before + 1
        assert last_state(c.llm)["newChatEvents"] == [{"field": "email", "result": "accepted"}]
        await c.engine.stop("hangup")

    async def test_two_events_within_1_s_one_acknowledgement_turn(self) -> None:
        c = await call(timed_audio=False)
        await c.step(100)
        before = len(c.llm.requests)
        c.port.emit(accepted("email"))
        await c.step(600)
        c.port.emit(accepted("serialNumber"))
        await c.step(2_000)
        assert len(c.llm.requests) == before + 1
        assert [e["field"] for e in last_state(c.llm)["newChatEvents"]] == ["email", "serialNumber"]
        await c.engine.stop("hangup")

    async def test_an_event_while_the_user_speaks_isnt_acknowledged_mid_speech_it_rides_along_with_the_next_agent_turn(
        self,
    ) -> None:
        c = await call(timed_audio=False)
        await c.step(100)
        before = len(c.llm.requests)
        c.stt.current.emit(SttSpeechStarted())
        c.stt.current.emit(SttTranscript(text="it's a laptop and", is_final=False, speech_final=False))
        c.port.emit(accepted("email"))
        await c.step(2_000)
        assert len(c.llm.requests) == before  # no turn while they talk
        c.stt.current.emit(SttTranscript(text="it's a laptop and it won't charge", is_final=True, speech_final=True))
        await c.step(500)
        assert len(c.llm.requests) == before + 1
        assert last_state(c.llm)["newChatEvents"] == [{"field": "email", "result": "accepted"}]
        assert [m for m in c.llm.requests[-1].messages if m.role == "user"][
            -1
        ].content == "it's a laptop and it won't charge"
        await c.engine.stop("hangup")

    async def test_rejections_are_counted_per_field_voice_help_after_2(self) -> None:
        c = await call(timed_audio=False)
        await c.step(100)
        rejected = {"type": "field.candidate", "payload": {"candidate": {"field": "serialNumber", "status": "invalid"}}}
        c.port.emit(rejected)
        c.port.emit(rejected)
        await c.step(1_500)
        assert last_state(c.llm)["newChatEvents"] == [{"field": "serialNumber", "result": "rejected", "rejections": 2}]
        await c.engine.stop("hangup")

    async def test_finalized_from_the_chat_during_the_call_stop_yes_the_agent_says_goodbye_and_ends_the_call(
        self,
    ) -> None:
        c = await call(timed_audio=False)
        await c.step(100)
        c.port.emit(
            {"type": "session.finalized", "channel": "system", "payload": {"outcome": "optedOut", "revision": 1}}
        )
        await c.step(500)
        assert OPTED_OUT_GOODBYE in c.tts.current.spoken()
        assert c.port.of("EndCall") == [{"type": "EndCall", "call_id": "c1", "reason": "opted_out"}]
        assert c.closes == [(CloseCode.NORMAL, "agent ended")]


class TestSilence:
    """P5-T10."""

    async def test_reprompts_at_8_s_and_16_s_then_ends_at_24_s_with_reason_silence_counted_from_when_the_agent_stopped_playing(
        self,
    ) -> None:
        c = await call(timed_audio=False)  # each line plays for 40-80 ms
        await c.step(7_900)
        assert REPROMPTS[0] not in c.tts.current.spoken()
        await c.step(300)
        assert REPROMPTS[0] in c.tts.current.spoken()
        await c.step(7_700)
        assert REPROMPTS[1] not in c.tts.current.spoken()
        await c.step(400)
        assert REPROMPTS[1] in c.tts.current.spoken()
        await c.step(7_700)
        assert c.port.of("EndCall") == []
        await c.step(400)
        assert c.port.of("EndCall") == [{"type": "EndCall", "call_id": "c1", "reason": "silence"}]
        assert c.closes == [(CloseCode.NORMAL, "silence")]

    async def test_isnt_counted_for_30_s_after_a_chat_card_opened_theyre_busy_typing(self) -> None:
        c = await call(timed_audio=False)
        await c.step(100)
        c.port.emit({"type": "input.requested", "payload": {}})
        await c.step(25_000, 100)
        assert REPROMPTS[0] not in c.tts.current.spoken()
        assert c.port.of("EndCall") == []
        await c.step(15_000, 100)
        assert REPROMPTS[0] in c.tts.current.spoken()
        await c.engine.stop("hangup")

    async def test_speech_resets_it(self) -> None:
        c = await call(timed_audio=False)
        await c.step(7_000)
        c.stt.current.emit(SttSpeechStarted())
        c.stt.current.emit(SttUtteranceEnd())
        await c.step(7_000)
        assert REPROMPTS[0] not in c.tts.current.spoken()
        await c.engine.stop("hangup")


class TestHowACallEnds:
    """P5-T09, P5-T10."""

    async def test_end_call_after_the_goodbye_has_played_endcall_agent_ended_and_the_socket_closes_agent_ended(
        self,
    ) -> None:
        c = await call(
            greeting=LlmScript(
                text="Thanks, that's all I need. Goodbye!", tool_calls=[{"name": "end_call", "args": {}}]
            )
        )
        await c.step(200)
        assert c.port.of("EndCall") == []  # still speaking
        await c.step(5_000)
        assert c.port.of("EndCall") == [{"type": "EndCall", "call_id": "c1", "reason": "agent_ended"}]
        assert c.closes == [(CloseCode.NORMAL, "agent ended")]
        # The goodbye was recorded before the end.
        types = [cmd["type"] for cmd in c.port.commands]
        assert types.index("AppendTranscript") < types.index("EndCall")

    async def test_opt_out_by_voice_confirmed_optoutbycall_the_goodbye_endcall_opted_out_the_hubs_finalized_event_adds_nothing(
        self,
    ) -> None:
        c = await call(timed_audio=False)
        await c.step(100)
        c.llm.enqueue(LlmScript(tool_calls=[{"name": "opt_out", "args": {"confirmed": True}}]))
        c.stt.current.say("yes please stop my claim")
        await c.step(400)
        c.port.emit({"type": "session.finalized", "channel": "system", "payload": {"outcome": "optedOut"}})
        await c.step(500)
        assert len(c.port.of("OptOutByCall")) == 1
        assert len(c.tts.current.spoken().split(OPTED_OUT_GOODBYE)) - 1 == 1
        assert c.port.of("EndCall") == [{"type": "EndCall", "call_id": "c1", "reason": "opted_out"}]

    async def test_opt_out_without_confirmation_finalizes_nothing_the_agent_must_ask_first(self) -> None:
        c = await call(timed_audio=False)
        await c.step(100)
        c.llm.enqueue(
            LlmScript(tool_calls=[{"name": "opt_out", "args": {"confirmed": False}}]),
            LlmScript(text="Do you want to stop your claim?"),
        )
        c.stt.current.say("i want to stop")
        await c.step(500)
        assert c.port.of("OptOutByCall") == []
        assert "Do you want to stop your claim?" in c.tts.current.spoken()
        await c.engine.stop("hangup")

    async def test_stt_fails_reconnect_once_the_second_failure_says_so_and_ends_with_provider_error(self) -> None:
        c = await call(timed_audio=False)
        await c.step(100)
        c.stt.current.emit(SttError(RuntimeError("dropped")))
        await c.step(100)
        assert len(c.stt.streams) == 2
        assert c.port.of("EndCall") == []
        c.stt.current.emit(SttError(RuntimeError("dropped again")))
        await c.step(500)
        assert PROVIDER_TROUBLE in c.tts.current.spoken()
        assert c.port.of("EndCall") == [{"type": "EndCall", "call_id": "c1", "reason": "provider_error"}]

    async def test_the_llm_failing_two_turns_in_a_row_ends_the_call_the_first_gets_the_filler_line(self) -> None:
        c = await call(greeting=LlmScript(error=LlmError("down", 503)), timed_audio=False)
        await c.step(200)
        assert c.tts.current.spoken() == FILLER_LINE
        c.llm.enqueue(LlmScript(error=LlmError("down", 503)))
        c.stt.current.say("hello")
        await c.step(600)
        assert c.port.of("EndCall") == [{"type": "EndCall", "call_id": "c1", "reason": "provider_error"}]

    async def test_tts_fails_the_agents_words_go_to_the_chat_and_the_call_ends(self) -> None:
        c = await call(timed_audio=False)
        await c.step(100)
        c.tts.current.fail_next_flush = True
        c.llm.enqueue(LlmScript(text="When did the problem start?"))
        c.stt.current.say("it is a laptop")
        await c.step(500)
        assert c.port.of("EndCall") == [{"type": "EndCall", "call_id": "c1", "reason": "provider_error"}]
        assert len(c.port.of("AgentSays")) <= 1

    async def test_the_maximum_duration_ends_the_call_the_planners_safety_net_ran_at_61_s(self) -> None:
        c = await call(timed_audio=False, timings=CallTimings(max_call_ms=90_000, silence_ms=1_000_000))
        await c.step(61_000, 500)
        assert c.port.reconciles == 1
        await c.step(30_000, 500)
        assert c.port.of("EndCall") == [{"type": "EndCall", "call_id": "c1", "reason": "max_duration"}]
        assert c.closes == [(CloseCode.NORMAL, "max duration")]

    async def test_the_socket_closing_ends_it_exactly_once_with_that_reason_closing_the_providers_no_close_back_to_the_socket(
        self,
    ) -> None:
        c = await call()
        await c.step(500)
        await asyncio.gather(c.engine.stop("network"), c.engine.stop("hangup"))
        assert c.port.of("EndCall") == [{"type": "EndCall", "call_id": "c1", "reason": "network"}]
        assert [c.stt.current.closed, c.tts.current.closed] == [True, True]
        assert c.closes == []
        assert c.engine.ended is True

    async def test_when_ended_is_pending_while_the_call_runs_and_resolves_once_it_has_ended_the_instances_call_cap_counts_on_it(
        self,
    ) -> None:
        c = await call(timed_audio=False)
        await c.step(200)
        assert c.engine.when_ended.done() is False
        await c.engine.stop("hangup")
        await flush()
        assert c.engine.when_ended.done() is True

    async def test_providers_that_cant_be_opened_end_the_call_at_once_provider_error(self) -> None:
        stt = FakeStt()
        stt.fail_next_open = 1
        port = FakePort()
        closes: list[Any] = []
        with pytest.raises(Exception, match="fake STT unavailable"):
            await CallEngine.start(
                call_id="c1",
                port=port,
                stt=stt,
                tts=FakeTts(),
                llm=FakeLlm(),
                clock=ManualClock(),
                log=NullLog(),
                send=lambda m: None,
                close=lambda *a: closes.append(a),
                returning=False,  # type: ignore[arg-type]
            )
        assert port.of("EndCall") == [{"type": "EndCall", "call_id": "c1", "reason": "provider_error"}]
        assert closes == [(CloseCode.NORMAL, "call ended")]


class TestP5ReviewFixes:
    async def test_1_two_utterances_while_a_turn_is_pending_only_one_new_turn_runs_with_both_utterances_tools_run_once(
        self,
    ) -> None:
        gate: asyncio.Future[None] = asyncio.get_running_loop().create_future()

        async def hold() -> None:
            await gate

        c = await call(greeting=LlmScript(text="Hello there. Which device is it?", gate=hold))
        await c.step(100)
        c.llm.enqueue(
            LlmScript(
                tool_calls=[
                    {
                        "name": "save_field",
                        "args": {"field": "deviceType", "value": "laptop", "spoken_evidence": "laptop"},
                    }
                ]
            ),
            LlmScript(text="Which model?"),
        )
        c.stt.current.say("It's a laptop")
        await c.step(400)
        c.stt.current.say("a Dell one")
        await c.step(400)
        gate.set_result(None)
        await c.step(3_000)
        assert len(c.llm.requests) == 3  # greeting + the one turn (and its follow-up)
        assert [(m.role, m.content) for m in [m for m in c.llm.requests[1].messages if m.role == "user"][-2:]] == [
            ("user", "It's a laptop"),
            ("user", "a Dell one"),
        ]
        assert len(c.port.of("SaveSpokenField")) == 1
        await c.engine.stop("hangup")

    async def test_2_an_stt_sockets_error_and_its_close_are_one_failure_one_reconnect_the_call_goes_on(self) -> None:
        from app.voice.types import SttClosed

        c = await call(timed_audio=False)
        await c.step(100)
        first = c.stt.current
        first.emit(SttError(RuntimeError("reset")))
        first.emit(SttClosed())
        await c.step(200)
        assert len(c.stt.streams) == 2
        assert c.port.of("EndCall") == []
        c.llm.enqueue(LlmScript(text="Got it."))
        c.stt.current.say("still here")
        await c.step(500)
        assert "Got it." in c.tts.current.spoken()
        await c.engine.stop("hangup")

    async def test_3_the_acknowledgement_goes_to_tts_at_once_while_the_follow_up_call_is_still_running(self) -> None:
        gate: asyncio.Future[None] = asyncio.get_running_loop().create_future()

        async def hold() -> None:
            await gate

        c = await call(timed_audio=False)
        await c.step(100)
        c.llm.enqueue(
            LlmScript(
                tool_calls=[
                    {
                        "name": "save_field",
                        "args": {
                            "field": "deviceModel",
                            "value": "Apple iPhone 14 Pro",
                            "spoken_evidence": "iphone 14 pro",
                        },
                    }
                ]
            ),
            LlmScript(text="What's wrong with it?", gate=hold),
        )
        c.port.replies["SaveSpokenField"] = lambda cmd: {
            "status": "valid",
            "normalized": {"brand": "Apple", "model": "iPhone 14 Pro"},
        }
        c.stt.current.say("an iphone 14 pro")
        await c.step(400)
        assert "Got it, Apple iPhone 14 Pro." in c.tts.current.spoken()  # before the follow-up has said anything
        gate.set_result(None)
        await c.step(500)
        assert "What's wrong with it?" in c.tts.current.spoken()
        await c.engine.stop("hangup")

    async def test_5_a_reply_the_user_talked_over_before_it_was_audible_is_dropped_not_played_first(self) -> None:
        gate: asyncio.Future[None] = asyncio.get_running_loop().create_future()

        async def hold() -> None:
            await gate

        c = await call(greeting=LlmScript(text="Hello! What device is it?", piece_chars=7, gate=hold))
        await c.step(50)
        c.llm.enqueue(LlmScript(text="A laptop, noted."))
        c.stt.current.say("it is a laptop")
        await c.step(400)
        gate.set_result(None)
        await c.step(2_000)
        assert "ta_c1_1" in c.tts.current.cancelled_turns
        assert stop_playbacks(c.sent) == []  # nothing was audible
        assert c.tts.current.spoken("ta_c1_2") == "A laptop, noted."
        await c.engine.stop("hangup")

    async def test_7_voice_activity_that_never_becomes_words_echo_noise_doesnt_stop_silence_handling_or_reset_the_reprompts(
        self,
    ) -> None:
        c = await call(timed_audio=False)
        await c.step(7_000)
        c.stt.current.emit(SttSpeechStarted())  # noise: no words, no UtteranceEnd
        await c.step(10_000)
        assert REPROMPTS[0] in c.tts.current.spoken()
        c.stt.current.emit(SttSpeechStarted())  # the reprompt's own echo
        await c.step(40_000, 100)
        assert c.port.of("EndCall") == [{"type": "EndCall", "call_id": "c1", "reason": "silence"}]

    async def test_8_a_chat_event_whose_turn_was_cut_off_before_it_spoke_is_kept_for_the_next_turn(self) -> None:
        gate: asyncio.Future[None] = asyncio.get_running_loop().create_future()

        async def hold() -> None:
            await gate

        c = await call(timed_audio=False)
        await c.step(100)
        c.port.emit({"type": "field.candidate", "payload": {"candidate": {"field": "email", "status": "valid"}}})
        c.llm.enqueue(LlmScript(text="Thanks for the email.", gate=hold), LlmScript(text="Sure."))
        await c.step(1_300)  # the proactive turn starts and waits on the model
        c.stt.current.say("hello?")
        await c.step(400)
        gate.set_result(None)
        await c.step(1_000)
        assert last_state(c.llm)["newChatEvents"] == [{"field": "email", "result": "accepted"}]
        await c.engine.stop("hangup")

    async def test_11_if_one_provider_opens_and_the_other_doesnt_the_opened_one_is_closed_again(self) -> None:
        stt = FakeStt()
        tts = FakeTts()
        tts.fail_next_open = 1
        with pytest.raises(Exception, match="fake TTS unavailable"):
            await CallEngine.start(
                call_id="c1",
                port=FakePort(),
                stt=stt,
                tts=tts,
                llm=FakeLlm(),
                clock=ManualClock(),
                log=NullLog(),
                send=lambda m: None,
                close=lambda *a: None,
                returning=False,  # type: ignore[arg-type]
            )
        assert stt.current.closed is True

    async def test_13_interrupted_during_acknowledge_then_ask_the_history_has_the_heard_text_once_the_earlier_messages_keep_only_their_tool_calls(
        self,
    ) -> None:
        long = "Got it. Now tell me exactly what happens to the screen when it starts flickering, and how often it happens during a normal day."
        c = await call(timed_audio=True)
        await c.step(3_000)
        c.llm.enqueue(
            LlmScript(
                tool_calls=[
                    {
                        "name": "save_field",
                        "args": {"field": "deviceType", "value": "smartphone", "spoken_evidence": "a phone"},
                    }
                ]
            ),
            LlmScript(text=long[len("Got it. ") :]),
        )
        c.port.replies["SaveSpokenField"] = lambda cmd: {"status": "valid", "normalized": "smartphone"}
        c.stt.current.say("it's a phone")
        await c.step(1_200)
        c.stt.current.emit(SttSpeechStarted())
        c.stt.current.emit(SttTranscript(text="it flickers", is_final=True, speech_final=True))
        await c.step(1_500)
        history = c.llm.requests[-1].messages
        assistants = [m for m in history if m.role == "assistant"][-2:]
        assert assistants[0].content is None  # the ack's message: tool calls only
        import re

        assert re.match(r"^Got it\..*\[interrupted\]$", str(assistants[1].content), re.S)
        await c.engine.stop("hangup")

    async def test_16_a_model_call_cut_off_before_usage_was_reported_still_counts_as_a_request(self) -> None:
        c = await call(greeting=LlmScript(text="One. Two. Three. Four. Five.", piece_chars=5))
        await c.step(600)
        c.stt.current.emit(SttSpeechStarted())
        c.stt.current.emit(SttTranscript(text="stop please", is_final=False, speech_final=False))
        await c.step(500)
        assert len(c.port.llm_requests) + len(c.port.llm_usage) >= 1
        await c.engine.stop("hangup")

    async def test_17_a_refused_opt_out_doesnt_end_the_call(self) -> None:
        c = await call(timed_audio=False)
        await c.step(100)
        c.port.replies["OptOutByCall"] = lambda cmd: {"status": "refused", "reason": "session is finalized"}
        c.llm.enqueue(
            LlmScript(tool_calls=[{"name": "opt_out", "args": {"confirmed": True}}]),
            LlmScript(text="Your claim is already submitted."),
        )
        c.stt.current.say("yes stop it")
        await c.step(600)
        assert c.port.of("EndCall") == []
        assert OPTED_OUT_GOODBYE not in c.tts.current.spoken()
        await c.engine.stop("hangup")

    async def test_14_when_tts_fails_the_current_turns_words_go_to_the_chat(self) -> None:
        c = await call(timed_audio=False)
        await c.step(100)
        c.tts.current.fail_next_flush = True
        c.llm.enqueue(LlmScript(text="When did the problem start?"))
        c.stt.current.say("it is a laptop")
        await c.step(500)
        assert c.port.of("AgentSays") == [{"type": "AgentSays", "text": "When did the problem start?"}]


class TestLiveCallFixes:
    """Fixes that came from live calls (ported with their behaviour; the TS covered them in the turn engine tests)."""

    async def test_an_ungrounded_save_field_never_reaches_the_session(self) -> None:
        c = await call(timed_audio=False)
        await c.step(100)
        c.llm.enqueue(
            LlmScript(
                tool_calls=[
                    {
                        "name": "save_field",
                        "args": {
                            "field": "urgency",
                            "value": "critical",
                            "spoken_evidence": "I need it back immediately it is critical",
                        },
                    }
                ]
            ),
            LlmScript(text="How urgent is it?"),
        )
        c.stt.current.say("hello there")
        await c.step(800)
        assert c.port.of("SaveSpokenField") == []
        await c.engine.stop("hangup")

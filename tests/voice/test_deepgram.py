"""The Deepgram STT adapter and the user-turn tracker (P5-T03).

Driven by REAL Deepgram events captured in P5-T01 (fixtures/providers/deepgram-stt-u1.json) and by a local mock of the
listen socket. No network.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlsplit

import pytest
from websockets.asyncio.server import ServerConnection, serve

from app.config import Secret
from app.voice.clock import ManualClock
from app.voice.deepgram import create_deepgram_stt, to_stt_event
from app.voice.fakes.stt import FakeStt
from app.voice.types import SttClosed, SttEvent, SttTranscript, SttUtteranceEnd
from app.voice.user_turns import UserLine, UserTurns, Utterance

FIXTURE = json.loads((Path(__file__).parent.parent / "fixtures" / "providers" / "deepgram-stt-u1.json").read_text())
EVENTS: list[dict[str, Any]] = FIXTURE["events"]
FINAL_TEXT = "Hi. My phone screen keeps flickering and then it goes completely black."


@dataclass
class Tracker:
    clock: ManualClock
    lines: list[UserLine] = field(default_factory=list)
    turns: list[Utterance] = field(default_factory=list)
    tracker: UserTurns | None = None


def track(merge_ms: float = 300) -> Tracker:
    t = Tracker(clock=ManualClock())
    t.tracker = UserTurns(
        call_id="c1", clock=t.clock, merge_ms=merge_ms, on_line=t.lines.append, on_turn_end=t.turns.append
    )
    return t


class TestRealDeepgramEvents:
    def test_maps_every_message_type_the_capture_contains_metadata_is_ignored(self) -> None:
        events = [to_stt_event(e["message"]) for e in EVENTS]
        assert [e.type for e in events if e] == [
            "speechStarted",
            "transcript",
            "transcript",
            "transcript",
            "transcript",
            "transcript",
            "transcript",
            "utteranceEnd",
            "transcript",
            "transcript",
        ]
        assert events[-1] is None  # Metadata

    def test_one_id_for_the_whole_utterance_interims_grow_in_place_the_final_replaces_them_the_turn_ends_once(
        self,
    ) -> None:
        t = track()
        assert t.tracker is not None
        for e in EVENTS:
            event = to_stt_event(e["message"])
            if event:
                t.tracker.handle(event)
        t.clock.advance(300)  # the merge window (UtteranceEnd already ended it)
        assert {line.id for line in t.lines} == {"tu_c1_1"}
        assert [line.text for line in t.lines if not line.final] == [
            "Hi. My phone",
            "Hi. My phone screen keeps",
            "Hi. My phone screen keeps flickering and then it",
            "Hi. My phone screen keeps flickering and then it goes completely",
            "Hi. My phone screen keeps flickering and then it goes completely black.",
        ]
        assert [line for line in t.lines if line.final] == [UserLine(id="tu_c1_1", text=FINAL_TEXT, final=True)]
        assert [turn.text for turn in t.turns] == [FINAL_TEXT]

    def test_speech_after_speech_final_but_within_the_merge_window_joins_the_same_turn_after_it_a_new_utterance(
        self,
    ) -> None:
        t = track(300)
        assert t.tracker is not None
        t.tracker.handle(SttTranscript(text="It's a Samsung", is_final=True, speech_final=True))
        t.clock.advance(200)
        t.tracker.handle(SttTranscript(text="Galaxy S23.", is_final=True, speech_final=True))
        t.clock.advance(300)
        assert [(turn.id, turn.text) for turn in t.turns] == [("tu_c1_1", "It's a Samsung Galaxy S23.")]
        t.tracker.handle(SttTranscript(text="Yes.", is_final=True, speech_final=True))
        t.clock.advance(300)
        assert [turn.id for turn in t.turns] == ["tu_c1_1", "tu_c1_2"]
        assert len([line for line in t.lines if line.final]) == 2

    def test_voice_activity_that_never_became_words_ends_quietly_no_line_no_turn(self) -> None:
        t = track()
        assert t.tracker is not None
        from app.voice.types import SttSpeechStarted

        t.tracker.handle(SttSpeechStarted())
        assert t.tracker.speaking is True
        t.tracker.handle(SttUtteranceEnd())
        assert t.lines == []
        assert t.turns == []
        assert t.tracker.speaking is False


@dataclass
class Mock:
    url: str
    seen: dict[str, Any] = field(default_factory=dict)


@asynccontextmanager
async def mock_listen(on_connect: Callable[[ServerConnection], Awaitable[None]]) -> AsyncIterator[str]:
    async with serve(on_connect, "127.0.0.1", 0) as server:
        port = next(iter(server.sockets)).getsockname()[1]
        yield f"ws://127.0.0.1:{port}/v1/listen"


class TestCreateDeepgramSttAgainstALocalMock:
    async def test_sends_the_measured_options_and_the_key_as_a_token_header_forwards_audio_maps_replies_and_closes_with_closestream(
        self,
    ) -> None:
        seen: dict[str, Any] = {"url": "", "auth": None, "bytes": 0, "control": []}

        async def handler(socket: ServerConnection) -> None:
            seen["url"] = socket.request.path
            seen["auth"] = socket.request.headers.get("Authorization")
            async for data in socket:
                if isinstance(data, bytes):
                    seen["bytes"] += len(data)
                    if seen["bytes"] == 640 * 3:
                        for e in EVENTS:
                            await socket.send(json.dumps(e["message"]))
                    continue
                message = json.loads(data)
                seen["control"].append(message["type"])
                if message["type"] == "CloseStream":
                    await socket.close(1000)

        async with mock_listen(handler) as url:
            events: list[SttEvent] = []
            stt = await create_deepgram_stt(api_key=Secret("fake-deepgram-key-for-tests"), url=url).open(events.append)
            for _ in range(3):
                stt.push(bytes(640))
            for _ in range(400):
                if any(isinstance(e, SttUtteranceEnd) for e in events):
                    break
                await asyncio.sleep(0.005)
            await stt.close()
        assert seen["auth"] == "Token fake-deepgram-key-for-tests"
        params = dict(parse_qsl(urlsplit(seen["url"]).query))
        for key, value in {
            "model": "nova-3-general",
            "encoding": "linear16",
            "sample_rate": "16000",
            "interim_results": "true",
            "endpointing": "150",
            "utterance_end_ms": "1000",
            "vad_events": "true",
        }.items():
            assert params[key] == value
        assert seen["bytes"] == 1920
        assert "CloseStream" in seen["control"]
        assert len([e for e in events if isinstance(e, SttTranscript) and e.speech_final and e.text]) == 1
        assert events[-1] == SttClosed()

    async def test_sends_keepalive_when_no_audio_has_gone_out_for_a_while_rejects_when_the_socket_cant_open(
        self,
    ) -> None:
        control: list[str] = []

        async def handler(socket: ServerConnection) -> None:
            async for data in socket:
                if not isinstance(data, bytes):
                    control.append(json.loads(data)["type"])

        async with mock_listen(handler) as url:
            stt = await create_deepgram_stt(api_key=Secret("k" * 24), url=url, keep_alive_ms=10).open(lambda e: None)
            await asyncio.sleep(1.2)
            assert "KeepAlive" in control
            await stt.close()
        with pytest.raises(Exception):  # noqa: B017  any failure to open is a rejection
            await create_deepgram_stt(
                api_key=Secret("k" * 24), url="ws://127.0.0.1:1/v1/listen", connect_timeout_ms=500
            ).open(lambda e: None)


class TestTheFakeSttReplaysTheRecordedFixtureLikeTheRealAdapter:
    async def test_same_events_same_utterance(self) -> None:
        fake = FakeStt()
        t = track()
        assert t.tracker is not None
        stream = await fake.open(t.tracker.handle)
        stream.replay([e["message"] for e in EVENTS])  # type: ignore[attr-defined]
        t.clock.advance(300)
        assert [turn.text for turn in t.turns] == [FINAL_TEXT]

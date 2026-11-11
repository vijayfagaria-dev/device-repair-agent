"""The Aura-2 TTS adapter (P5-T04) against a local mock of the speak socket that behaves like the P5-T01 capture.

1,920-byte frames then ``Flushed``; after ``Clear``, more frames keep coming before ``Cleared`` (or none comes at all).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qsl, urlsplit

from websockets.asyncio.server import ServerConnection, serve

from app.config import Secret
from app.voice.deepgram_tts import create_deepgram_tts
from app.voice.types import TtsAudio, TtsClosed, TtsEvent, TtsFlushed


@dataclass
class MockOptions:
    #: Answer Clear this late (after the adapter has given up and reopened).
    cleared_after_ms: float | None = None
    frames_per_chunk: int = 3
    #: Frames still sent after Clear (P0-T03 measured 1.1-2.2 s worth).
    frames_after_clear: int = 4
    #: Never answer Clear.
    no_cleared: bool = False
    #: Drop the connection after this many frames of the first chunk.
    drop_after_frames: int | None = None


@dataclass
class Connection:
    url: str
    auth: str | None
    received: list[str] = field(default_factory=list)


@asynccontextmanager
async def mock(options: MockOptions | None = None) -> AsyncIterator[tuple[str, list[Connection]]]:
    options = options or MockOptions()
    connections: list[Connection] = []
    state = {"dropped": False}

    async def handler(socket: ServerConnection) -> None:
        connection = Connection(socket.request.path, socket.request.headers.get("Authorization"))
        connections.append(connection)
        pending = ""
        busy_until = 0.0
        tasks: list[asyncio.Task[Any]] = []

        def now_ms() -> float:
            return time.monotonic() * 1000

        def later(delay_ms: float, action: Callable[[], Any]) -> asyncio.Task[Any]:
            async def run() -> None:
                await asyncio.sleep(max(0.0, delay_ms) / 1000)
                with contextlib.suppress(Exception):
                    await action()

            task = asyncio.get_running_loop().create_task(run())
            tasks.append(task)
            return task

        async def send(data: bytes | str) -> None:
            if socket.state.name == "OPEN":
                await socket.send(data)

        def frame(byte: int) -> bytes:
            return bytes([byte]) * 1920

        try:
            async for data in socket:
                message = json.loads(data)
                connection.received.append(
                    f"Speak:{message.get('text')}" if message["type"] == "Speak" else message["type"]
                )
                if message["type"] == "Speak":
                    pending += message.get("text") or ""
                if message["type"] == "Flush":
                    # Chunks are spoken one after another, like Aura-2: this one starts when the previous one is done.
                    text, pending = pending, ""
                    n = options.frames_per_chunk
                    start = max(now_ms(), busy_until)
                    busy_until = start + 5 * (n + 1)
                    offset = start - now_ms()
                    for i in range(n):

                        async def send_frame(i: int = i, text: str = text) -> None:
                            if (
                                not state["dropped"]
                                and options.drop_after_frames is not None
                                and i == options.drop_after_frames
                            ):
                                state["dropped"] = True
                                socket.transport.abort()
                                return
                            await send(frame(len(text) % 256))

                        later(offset + 5 * (i + 1), send_frame)
                    later(offset + 5 * (n + 1), lambda: send(json.dumps({"type": "Flushed"})))
                if message["type"] == "Clear":
                    for task in tasks:
                        task.cancel()
                    tasks.clear()
                    busy_until = 0.0
                    for i in range(options.frames_after_clear):
                        later(3 * (i + 1), lambda: send(frame(9)))
                    if not options.no_cleared:
                        delay = (
                            options.cleared_after_ms
                            if options.cleared_after_ms is not None
                            else 3 * (options.frames_after_clear + 2)
                        )
                        later(delay, lambda: send(json.dumps({"type": "Cleared"})))
                if message["type"] == "Close":
                    await socket.close(1000)
        finally:
            for task in tasks:
                task.cancel()

    async with serve(handler, "127.0.0.1", 0) as server:
        port = next(iter(server.sockets)).getsockname()[1]
        yield f"ws://127.0.0.1:{port}/v1/speak", connections
        for client in list(server.connections):
            client.transport.abort()


async def wait_for(check: Callable[[], bool], seconds: float = 3.0) -> None:
    deadline = time.monotonic() + seconds
    while not check():
        if time.monotonic() > deadline:
            raise TimeoutError("timed out")
        await asyncio.sleep(0.005)


@dataclass
class Opened:
    stream: Any
    events: list[TtsEvent]

    def audio(self, turn_id: str | None = None) -> list[TtsAudio]:
        return [e for e in self.events if isinstance(e, TtsAudio) and (turn_id is None or e.turn_id == turn_id)]

    def flushed(self) -> list[TtsFlushed]:
        return [e for e in self.events if isinstance(e, TtsFlushed)]


async def open_stream(url: str, **extra: Any) -> Opened:
    events: list[TtsEvent] = []
    stream = await create_deepgram_tts(
        api_key=Secret("fake-deepgram-key-for-tests"), url=url, voice="aura-2-thalia-en", **extra
    ).open(events.append)
    return Opened(stream, events)


class TestAura2Adapter:
    async def test_asks_for_linear16_at_24_khz_with_the_voice_and_the_key_forwards_each_chunks_audio_in_order_tagged_with_its_turn_then_flushed(
        self,
    ) -> None:
        async with mock() as (url, connections):
            o = await open_stream(url)
            o.stream.speak("ta_c_1", "Hello there.")
            o.stream.flush("ta_c_1")
            o.stream.speak("ta_c_1", "Which model is it?")
            o.stream.flush("ta_c_1")
            await wait_for(lambda: len(o.flushed()) == 2)
            assert connections[0].auth == "Token fake-deepgram-key-for-tests"
            assert dict(parse_qsl(urlsplit(connections[0].url).query)) == {
                "model": "aura-2-thalia-en",
                "encoding": "linear16",
                "sample_rate": "24000",
            }
            assert connections[0].received == ["Speak:Hello there.", "Flush", "Speak:Which model is it?", "Flush"]
            # 3 frames per chunk; one "flushed" per chunk, in order.
            assert len(o.audio("ta_c_1")) == 6
            assert [e.pcm[0] for e in o.audio()] == [12, 12, 12, 18, 18, 18]
            assert o.flushed() == [TtsFlushed("ta_c_1"), TtsFlushed("ta_c_1")]
            assert all(e.sample_rate == 24000 and len(e.pcm) == 1920 for e in o.audio())
            await o.stream.close()

    async def test_after_cancel_not_one_more_frame_of_that_turn_is_emitted_although_the_provider_keeps_sending_after_clear(
        self,
    ) -> None:
        async with mock(MockOptions(frames_per_chunk=20, frames_after_clear=6)) as (url, connections):
            o = await open_stream(url)
            o.stream.speak("ta_c_1", "This is a long sentence that will be interrupted.")
            o.stream.flush("ta_c_1")
            await wait_for(lambda: len(o.audio()) >= 2)
            o.stream.cancel("ta_c_1")
            at_cancel = len(o.audio())
            # The next turn waits for Cleared, then plays.
            o.stream.speak("ta_c_2", "Sure, go ahead.")
            o.stream.flush("ta_c_2")
            await wait_for(lambda: any(isinstance(e, TtsFlushed) and e.turn_id == "ta_c_2" for e in o.events))
            assert len(o.audio("ta_c_1")) == at_cancel  # 0 frames after cancel
            assert len(o.audio("ta_c_2")) > 0
            assert all(e.pcm[0] != 9 for e in o.audio("ta_c_2"))  # none of the post-Clear frames
            assert connections[0].received == [
                "Speak:This is a long sentence that will be interrupted.",
                "Flush",
                "Clear",
                "Speak:Sure, go ahead.",
                "Flush",
            ]
            await o.stream.close()

    async def test_if_cleared_doesnt_come_within_the_timeout_a_fresh_socket_is_opened_and_the_next_turn_plays_on_it(
        self,
    ) -> None:
        async with mock(MockOptions(frames_per_chunk=20, frames_after_clear=3, no_cleared=True)) as (url, connections):
            o = await open_stream(url, clear_timeout_ms=100)
            o.stream.speak("ta_c_1", "Interrupt me.")
            o.stream.flush("ta_c_1")
            await wait_for(lambda: len(o.audio()) >= 1)
            o.stream.cancel("ta_c_1")
            o.stream.speak("ta_c_2", "Next.")
            o.stream.flush("ta_c_2")
            await wait_for(lambda: any(isinstance(e, TtsFlushed) and e.turn_id == "ta_c_2" for e in o.events))
            assert len(connections) == 2
            assert connections[1].received == ["Speak:Next.", "Flush"]
            await o.stream.close()

    async def test_a_socket_dropped_mid_chunk_is_reopened_once_and_the_unfinished_chunk_is_sent_again(self) -> None:
        async with mock(MockOptions(frames_per_chunk=5, drop_after_frames=2)) as (url, connections):
            o = await open_stream(url)
            o.stream.speak("ta_c_1", "Please say that again.")
            o.stream.flush("ta_c_1")
            await wait_for(lambda: len(o.flushed()) > 0)
            assert len(connections) == 2
            assert connections[1].received == ["Speak:Please say that again.", "Flush"]
            assert len(o.audio("ta_c_1")) >= 5
            assert not any(e.type == "error" for e in o.events)
            await o.stream.close()

    async def test_ignores_text_for_a_cancelled_turn_and_close_sends_close(self) -> None:
        async with mock() as (url, connections):
            o = await open_stream(url)
            o.stream.cancel("ta_c_9")
            o.stream.speak("ta_c_9", "Nothing.")
            o.stream.flush("ta_c_9")
            await o.stream.close()
            assert connections[0].received == ["Close"]
            assert o.events[-1] == TtsClosed()

    async def test_6_a_cleared_that_comes_after_the_adapter_reopened_doesnt_send_the_waiting_speech_to_the_old_socket(
        self,
    ) -> None:
        async with mock(MockOptions(frames_per_chunk=20, frames_after_clear=3, cleared_after_ms=150)) as (
            url,
            connections,
        ):
            o = await open_stream(url, clear_timeout_ms=100)
            o.stream.speak("ta_c_1", "Interrupt me.")
            o.stream.flush("ta_c_1")
            await wait_for(lambda: len(o.audio()) >= 1)
            o.stream.cancel("ta_c_1")
            o.stream.speak("ta_c_2", "Next.")
            o.stream.flush("ta_c_2")
            await wait_for(lambda: any(isinstance(e, TtsFlushed) and e.turn_id == "ta_c_2" for e in o.events))
            assert len(connections) == 2
            assert [r for r in connections[0].received if r.startswith("Speak")] == ["Speak:Interrupt me."]
            assert connections[1].received == ["Speak:Next.", "Flush"]
            assert all(e.pcm[0] != 9 for e in o.audio("ta_c_2"))
            await o.stream.close()

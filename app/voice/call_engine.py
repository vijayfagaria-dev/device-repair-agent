"""The call engine (P5-T07...T12, architecture section 6): one per live call.

It wires the user's speech (STT -> utterances -> transcript lines and turn ends), the agent's turns (turn engine ->
speech out -> audio and the agent line), the agent's tools (as commands) and the session's chat events, and it owns
every way a call ends.

- One agent turn at a time. A user utterance that ends while the agent is still thinking replaces that turn.
- Barge-in (P5-T07): confirmed speech while the agent is audible -> stopPlayback FIRST, then the LLM is aborted, TTS
  cancelled, and the agent line and history are truncated at what was heard, marked [interrupted]. Tool calls already
  committed stay.
- Chat events (P5-T08) from the hub are batched into the next state message; when nobody is speaking for 1.2 s a
  proactive turn acknowledges them. Voice help is offered after 2+ rejections (the state carries the count).
- Endings (P5-T09/T10): the agent's end_call (after its goodbye has played), the user hanging up, a dropped socket,
  silence (reprompts at 8 s and 16 s, end at 24 s, suspended for 30 s after a chat card opens), the maximum duration,
  provider failure, an opt-out (by voice or from the chat). Every path ends the call exactly once (EndCall), and the chat
  takes over (P4 planner).
- A returning call (P5-T12) greets with what's collected: the state says isReturningCall and the last question.

Commands sent to the session (``port.dispatch``), as dicts with a ``type``: ``AppendTranscript`` (``line``: id, call_id,
role, text, started_at, interrupted?), ``SaveSpokenField`` (field, value, evidence, user_confirmed?), ``RequestInput``
(field), ``FlagForReview`` (kind, reason), ``OptOutByCall``, ``AgentSays`` (text), ``EndCall`` (call_id, reason).
"""

from __future__ import annotations

import asyncio
import contextlib
import math
from collections.abc import Callable, Coroutine
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any

from app.agent.chat_planner import is_record_field
from app.agent.grounding import grounding_error
from app.agent.prompt import system_message
from app.agent.state_message import ChatEventNote, StateInput, state_message
from app.agent.tools import ParsedToolCall
from app.agent.turn_engine import ToolOutcome, TurnDeps, TurnInput, run_turn
from app.agent.voice_templates import (
    OPTED_OUT_GOODBYE,
    PROVIDER_TROUBLE,
    REPROMPTS,
    SUBMITTED_GOODBYE,
    card_sent_ack,
    saved_ack,
    type_it_ack,
)
from app.metrics.latency import TurnFacts, build_turn_metric
from app.protocol.enums import Role
from app.protocol.session import CloseCode
from app.protocol.types import StopPlaybackMessage, TranscriptMessage
from app.voice.barge_in import DEFAULT_BARGE_IN, BargeInFacts, BargeInSettings, should_barge_in
from app.voice.call_session import CallEndReason, CallSessionPort
from app.voice.clock import Clock
from app.voice.speech_out import INTERRUPTED_MARK, CallMessage, SpeechTurn, SpokenTurn
from app.voice.types import (
    AbortSignal,
    LlmClient,
    LlmMessage,
    LlmRoute,
    LlmUsage,
    SttError,
    SttEvent,
    SttProvider,
    SttStream,
    SttTranscript,
    TtsAudio,
    TtsError,
    TtsEvent,
    TtsFlushed,
    TtsProvider,
    TtsStream,
    pcm_bytes_per_second,
)
from app.voice.user_turns import UserLine, UserTurns, Utterance


@dataclass(frozen=True, slots=True)
class CallTimings:
    #: Words within this long after speech_final join the same user turn.
    merge_ms: float = 300
    silence_ms: float = 8_000
    #: Reprompts before a silent call ends (PD3: 2, so the call ends at 3 x silence_ms).
    silence_reprompts: int = 2
    #: Nobody speaking for this long -> a proactive turn for new chat events (P5-T08).
    proactive_idle_ms: float = 1_200
    #: Silence isn't counted for this long after a chat card opened (the user is busy typing, P5-T10).
    card_suspend_ms: float = 30_000
    max_call_ms: float = 10 * 60_000
    #: The planner's 60 s safety net runs at this point of the call (P4-T01).
    safety_net_ms: float = 61_000


DEFAULT_CALL_TIMINGS = CallTimings()

MIC_BYTES_PER_SECOND = pcm_bytes_per_second(16_000)
#: The longest an agent turn may take to play out before it is cancelled (a provider that never finishes).
TURN_WATCHDOG_MS = 45_000


class _AgentTurn:
    __slots__ = ("abort", "id", "running", "speech", "stt_ms", "user_end_at")

    def __init__(self, id_: str, speech: SpeechTurn, user_end_at: float | None, stt_ms: float | None) -> None:
        self.id = id_
        self.speech = speech
        self.abort = AbortSignal()
        self.user_end_at = user_end_at
        #: STT's end-of-utterance event -> this turn starting (the merge window); None for a turn no utterance caused.
        self.stt_ms = stt_ms
        self.running: asyncio.Future[Any] | None = None


def _reply_get(reply: Any, key: str) -> Any:
    if reply is None:
        return None
    if isinstance(reply, dict):
        return reply.get(key)
    return getattr(reply, key, None)


def _utc(ms: float) -> datetime:
    return datetime.fromtimestamp(ms / 1000, UTC)


async def _nothing() -> None:
    return None


def _eager(coro: Coroutine[Any, Any, Any]) -> asyncio.Task[Any]:
    """Starts ``coro`` now and runs it up to its first suspension, as a JavaScript async function does when called."""
    return asyncio.Task(coro, loop=asyncio.get_running_loop(), eager_start=True)


class CallEngine:
    def __init__(
        self,
        *,
        call_id: str,
        port: CallSessionPort,
        stt: SttProvider,
        tts: TtsProvider,
        llm: LlmClient,
        clock: Clock,
        log: Any,
        send: Callable[[CallMessage], None],
        close: Callable[[int, str], None],
        returning: bool,
        timings: CallTimings | None = None,
        barge_in: BargeInSettings | None = None,
    ) -> None:
        self._call_id = call_id
        self._port = port
        self._stt_provider = stt
        self._tts_provider = tts
        self._llm = llm
        self._clock = clock
        self._log = log
        self._send = send
        self._close = close
        self._returning = returning
        self._t = timings or DEFAULT_CALL_TIMINGS
        self._barge_in_settings = barge_in
        self._started_at = clock.now()
        self._history: list[LlmMessage] = []
        self._stt: SttStream | None = None
        self._tts: TtsStream | None = None
        self._stt_retried = False
        self._turn: _AgentTurn | None = None
        self._turn_count = 0
        #: Turn requests so far: only the newest one runs once the previous turn is done (P5 review #1).
        self._turn_gen = 0
        #: User utterances not yet in the history: the next turn that runs takes them all, in order.
        self._pending_user: list[str] = []
        #: STT streams opened: events from a replaced stream are ignored (its error and close are one failure, #2).
        self._stt_gen = 0
        self._failures = 0
        self._pending: list[ChatEventNote] = []
        #: Counts chat events that reached the call: a turn that started before one has a stale state (turn engine is_stale).
        self._chat_seq = 0
        self._rejections: dict[str, int] = {}
        self._last_card_at = -math.inf
        self._reprompts = 0
        self._silence_timer: Any = None
        self._proactive_timer: Any = None
        self._barge_timer: Any = None
        self._timers: list[Any] = []
        self._unsubscribe: Callable[[], None] | None = None
        self._stt_bytes = 0
        self._ending: asyncio.Future[None] | None = None
        #: Set first thing when the call ends, before any provider is closed (their close events must not look unexpected).
        self._stopping = False
        #: Resolves once the call has fully ended (EndCall done).
        self._ended: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        #: This engine finalized the session itself (opt_out): the hub's session.finalized needs no goodbye.
        self._self_finalized = False
        self._background: set[asyncio.Future[Any]] = set()
        #: Barge-ins this call (for the log and tests).
        self.barge_ins = 0
        self._user_turns = UserTurns(
            call_id=call_id,
            clock=clock,
            merge_ms=self._t.merge_ms,
            on_line=self._on_user_line,
            on_turn_end=self._on_user_turn_end,
            on_speech_started=self._on_speech_started,
            on_speech_abandoned=self._on_speech_abandoned,
        )

    @classmethod
    async def start(
        cls,
        *,
        call_id: str,
        port: CallSessionPort,
        stt: SttProvider,
        tts: TtsProvider,
        llm: LlmClient,
        clock: Clock,
        log: Any,
        send: Callable[[CallMessage], None],
        close: Callable[[int, str], None],
        returning: bool,
        timings: CallTimings | None = None,
        barge_in: BargeInSettings | None = None,
    ) -> CallEngine:
        """Opens the providers and greets. Raises (after ending the call) if a provider can't be opened."""
        engine = cls(
            call_id=call_id,
            port=port,
            stt=stt,
            tts=tts,
            llm=llm,
            clock=clock,
            log=log,
            send=send,
            close=close,
            returning=returning,
            timings=timings,
            barge_in=barge_in,
        )
        await engine._begin()
        return engine

    @property
    def call_id(self) -> str:
        return self._call_id

    @property
    def ended(self) -> bool:
        return self._stopping

    @property
    def when_ended(self) -> asyncio.Future[None]:
        """Resolves when the call has fully ended (not before it has started ending)."""
        return self._ended

    # ---------------------------------------------------------------------------------------------------------------
    # plumbing

    def _spawn(self, coro: Coroutine[Any, Any, Any] | asyncio.Future[Any]) -> asyncio.Future[Any]:
        """``void promise``: runs in the background; an unexpected error is logged."""
        task = coro if isinstance(coro, asyncio.Future) else _eager(coro)
        self._background.add(task)

        def done(t: asyncio.Future[Any]) -> None:
            self._background.discard(t)
            if not t.cancelled() and t.exception() is not None:
                self._log.error("background task failed", message=str(t.exception()))

        task.add_done_callback(done)
        return task

    @property
    def _bargein(self) -> BargeInSettings:
        return self._barge_in_settings or DEFAULT_BARGE_IN

    async def _begin(self) -> None:
        # Both at once: each is a WebSocket handshake to the provider (~1 s from far away).
        self._stt_gen += 1
        gen = self._stt_gen
        stt, tts = await asyncio.gather(
            self._stt_provider.open(lambda event: self._on_stt(event, gen)),
            self._tts_provider.open(self._on_tts),
            return_exceptions=True,
        )
        if isinstance(stt, BaseException) or isinstance(tts, BaseException):
            # Whichever did open is closed again (P5 review #11).
            if not isinstance(stt, BaseException):
                with contextlib.suppress(Exception):
                    await stt.close()
            if not isinstance(tts, BaseException):
                with contextlib.suppress(Exception):
                    await tts.close()
            err = stt if isinstance(stt, BaseException) else tts
            assert isinstance(err, BaseException)
            self._log.error("call providers unavailable", message=str(err))
            await self._end("provider_error", (CloseCode.NORMAL, "call ended"))
            raise err
        self._stt = stt
        self._tts = tts
        self._unsubscribe = self._port.subscribe(self._on_session_update)
        self._timers.append(self._clock.set_timeout(self._max_duration_reached, self._t.max_call_ms))
        self._timers.append(self._clock.set_timeout(lambda: self._spawn(self._reconcile()), self._t.safety_net_ms))
        self._spawn(
            self._agent_turn(
                opening="(The customer called back.)" if self._returning else "(The call has just connected.)"
            )
        )

    def _max_duration_reached(self) -> None:
        self._spawn(self._end("max_duration", (CloseCode.NORMAL, "max duration")))

    async def _reconcile(self) -> None:
        with contextlib.suppress(Exception):
            await self._port.reconcile()

    def push_audio(self, pcm: bytes) -> None:
        """One mic frame (20 ms PCM16 at 16 kHz)."""
        if self._stopping or self._stt is None:
            return
        self._stt_bytes += len(pcm)
        self._stt.push(pcm)

    def stop(self, reason: CallEndReason) -> asyncio.Future[None]:
        """The socket closed (the user hung up, the network dropped, the server is restarting)."""
        return self._end(reason, None)

    # ---------------------------------------------------------------------------------------------------------------
    # The user

    def _on_stt(self, event: SttEvent, gen: int) -> None:
        if self._stopping or gen != self._stt_gen:
            return
        if event.type in ("error", "closed"):
            error = event.error if isinstance(event, SttError) else RuntimeError("STT closed")
            # The failed stream is done with: its remaining events (ws sends close after error) are ignored, from now on
            # (this runs synchronously, as the TypeScript's async function did up to its first await).
            self._stt_gen += 1
            self._spawn(self._stt_failed(error, self._stt_gen))
            return
        self._user_turns.handle(event)
        if isinstance(event, SttTranscript):
            self._check_barge_in()

    async def _stt_failed(self, error: BaseException, gen: int) -> None:
        if self._stopping:
            return
        if not self._stt_retried:
            # Reconnect once (failure matrix); the user hears nothing of it.
            self._stt_retried = True
            self._log.warning("STT stream failed; reconnecting once", message=str(error))
            try:
                stream = await self._stt_provider.open(lambda event: self._on_stt(event, gen))
            except Exception:
                pass  # fall through
            else:
                if self._stopping:
                    with contextlib.suppress(Exception):
                        await stream.close()  # the call ended meanwhile
                    return
                self._stt = stream
                return
        self._log.error("STT unavailable; ending the call", message=str(error))
        await self._say_templated(PROVIDER_TROUBLE)
        await self._end("provider_error", (CloseCode.NORMAL, "call ended"))

    def _on_speech_started(self) -> None:
        # Silence pauses; it re-arms if this turns out to be no words (on_speech_abandoned). Reprompts reset only on words.
        self._clear_silence()
        # The duration path of the barge-in rule needs a check once the speech has lasted long enough.
        if self._barge_timer is not None:
            self._clock.clear_timeout(self._barge_timer)
        self._barge_timer = self._clock.set_timeout(self._barge_timer_fired, self._bargein.min_speech_ms)

    def _barge_timer_fired(self) -> None:
        self._barge_timer = None
        self._check_barge_in()

    def _on_speech_abandoned(self) -> None:
        if not self._stopping and self._turn is None:
            self._arm_silence()

    def _on_user_line(self, line: UserLine) -> None:
        self._send(TranscriptMessage(id=line.id, role=Role.USER, text=line.text, final=line.final))
        if line.text:
            self._reprompts = 0
        if line.final and line.text:
            self._dispatch_quietly(
                {
                    "type": "AppendTranscript",
                    "line": {
                        "id": line.id,
                        "call_id": self._call_id,
                        "role": Role.USER,
                        "text": line.text,
                        "started_at": _utc(self._clock.now()),
                    },
                }
            )

    def _on_user_turn_end(self, utterance: Utterance) -> None:
        if self._stopping:
            return
        self._reprompts = 0
        turn = self._turn
        # The user finished speaking while the agent was still on its turn: their words win (an interruption if heard).
        if turn is not None:
            if turn.speech.audible and turn.speech.speaking:
                self._barge_in(turn)
            else:
                # Nothing heard yet: drop it quietly, so its queued speech doesn't play first (P5 review #5).
                turn.abort.abort()
                turn.speech.cancel()
        self._spawn(
            self._agent_turn(
                user_text=utterance.text,
                user_end_at=utterance.end_event_at,
                stt_ms=utterance.ended_at - utterance.end_event_at,
            )
        )

    def _check_barge_in(self) -> None:
        turn = self._turn
        if turn is None or self._stopping:
            return
        facts = BargeInFacts(
            agent_audible_since=turn.speech.first_audio_at,
            agent_speaking=turn.speech.speaking,
            user_speech_since=self._user_turns.speech_started_at,
            words=self._user_turns.words,
            now=self._clock.now(),
        )
        if should_barge_in(facts, self._bargein):
            self._barge_in(turn)

    def _barge_in(self, turn: _AgentTurn) -> None:
        """Stops the agent at once: stopPlayback first (the user-audible stop doesn't wait for any provider)."""
        if not turn.speech.speaking:
            return
        self._send(StopPlaybackMessage())
        turn.speech.cancel()
        turn.abort.abort()
        self.barge_ins += 1
        self._log.info("barge-in", turn_id=turn.id)

    # ---------------------------------------------------------------------------------------------------------------
    # The agent

    async def _agent_turn(
        self,
        *,
        user_text: str | None = None,
        user_end_at: float | None = None,
        stt_ms: float | None = None,
        opening: str | None = None,
        proactive: bool = False,
    ) -> None:
        if self._stopping:
            return
        self._clear_silence()
        self._clear_proactive()
        if user_text:
            self._pending_user.append(user_text)
        elif opening:
            self._pending_user.append(opening)
        self._turn_gen += 1
        gen = self._turn_gen
        previous = self._turn
        if previous is not None:
            previous.abort.abort()
            await self._await_quietly(previous.running)
        # A newer request arrived while waiting: it runs instead, with every utterance (one agent turn at a time).
        if self._stopping or gen != self._turn_gen:
            return
        pending_user, self._pending_user = self._pending_user, []
        for content in pending_user:
            self._history.append(LlmMessage(role="user", content=content))
        notes, self._pending = self._pending, []
        self._turn_count += 1
        turn_id = f"ta_{self._call_id}_{self._turn_count}"
        assert self._tts is not None
        speech = SpeechTurn(turn_id, self._tts, self._clock, self._send)
        turn = _AgentTurn(turn_id, speech, user_end_at, stt_ms)
        self._turn = turn
        turn.running = _eager(self._run_agent_turn_guarded(turn, notes))
        await turn.running

    @staticmethod
    async def _await_quietly(future: asyncio.Future[Any] | None) -> None:
        if future is None:
            return
        try:
            await future
        except asyncio.CancelledError:
            current = asyncio.current_task()
            if current is not None and current.cancelling() > 0:
                raise
        except Exception:
            pass

    async def _run_agent_turn_guarded(self, turn: _AgentTurn, notes: list[ChatEventNote]) -> None:
        try:
            await self._run_agent_turn(turn, notes)
        except Exception as err:
            self._log.error("agent turn failed", message=str(err))
            self._record_turn_metric(turn, None, None)  # a reply to a user utterance still gets its row

    async def _run_agent_turn(self, turn: _AgentTurn, notes: list[ChatEventNote]) -> None:
        seq = self._chat_seq
        port = self._port
        speech = turn.speech

        def on_round(route: LlmRoute, usage: LlmUsage | None) -> None:
            # Charged as each call ends, not after playback (P5 review #16); an aborted call still counts as a request.
            self._spawn(port.record_llm_usage(route, usage) if usage else port.record_llm_request(route))

        class Sink:
            def say(self, text: str) -> None:
                speech.say(text)

            def break_chunk(self) -> None:
                speech.break_chunk()

        out = await run_turn(
            TurnDeps(llm=self._llm, tools=_Tools(self), on_round=on_round),
            TurnInput(
                history=[system_message(), *self._history],
                state=lambda: self._state(notes),
                signal=turn.abort,
                is_stale=lambda: self._chat_seq != seq,
            ),
            Sink(),
        )
        speech.end()
        # Until the user has heard it all (or interrupted it): barge-in stays possible, and silence counts from here.
        spoken = await self._played_out(turn)
        self._after_agent_turn(turn, spoken, out.messages)
        # Chat events this turn never got to mention go back for the next one (P5 review #8).
        if not spoken.heard and (out.aborted or spoken.interrupted):
            self._restore_notes(notes)
        if spoken.characters > 0:
            self._spawn(port.record_tts_characters(spoken.characters))
        self._record_turn_metric(turn, spoken, out.rounds[0].ttft_ms if out.rounds else None)
        if out.refused:
            self._dispatch_quietly(
                {"type": "FlagForReview", "kind": "other", "reason": "the call agent gave no usable reply"}
            )
        if self._turn is turn:
            self._turn = None
        if self._stopping:
            return

        self._failures = self._failures + 1 if out.failed else 0
        if self._failures >= 2:
            await self._end("provider_error", (CloseCode.NORMAL, "call ended"))
            return
        if out.end_call:
            # The goodbye has played (speech.done): now close (P5-T09).
            await self._end("opted_out" if self._self_finalized else "agent_ended", (CloseCode.NORMAL, "agent ended"))
            return
        if not spoken.interrupted:
            self._arm_silence()
        if self._pending:
            self._schedule_proactive()

    def _record_turn_metric(self, turn: _AgentTurn, spoken: SpokenTurn | None, llm_ttft_ms: float | None) -> None:
        """The turn's latency row (P11-T02, D20). Never fails the call: the port logs a write error."""
        metric = build_turn_metric(
            TurnFacts(
                turn_id=turn.id,
                call_id=self._call_id,
                user_end_at=turn.user_end_at,
                first_audio_at=spoken.first_audio_at if spoken else None,
                stt_ms=turn.stt_ms,
                llm_ttft_ms=llm_ttft_ms,
                tts_ttfb_ms=spoken.tts_ttfb_ms if spoken else None,
            )
        )
        if metric is not None:
            self._spawn(self._port.record_turn_metric(metric))

    async def _played_out(self, turn: _AgentTurn) -> SpokenTurn:
        """Waits for the turn to play out, at most TURN_WATCHDOG_MS (a provider that never finishes can't hang the call)."""

        def watchdog() -> None:
            self._log.warning("agent turn didn't finish playing; cancelled", turn_id=turn.id)
            turn.speech.cancel()

        timer = self._clock.set_timeout(watchdog, TURN_WATCHDOG_MS)
        try:
            return await turn.speech.played_out()
        finally:
            self._clock.clear_timeout(timer)

    def _restore_notes(self, notes: list[ChatEventNote]) -> None:
        for note in notes:
            if not any(n.field == note.field for n in self._pending):
                self._pending.insert(0, note)

    def _after_agent_turn(self, turn: _AgentTurn, spoken: SpokenTurn, messages: list[LlmMessage]) -> None:
        """History and transcript after a turn: an interrupted line is cut to what the user heard (P5-T07)."""
        if spoken.interrupted:
            heard = f"{spoken.heard}{INTERRUPTED_MARK}".strip()
            # The heard text covers the whole turn (acknowledgements included): it goes on the last assistant message
            # and the earlier ones keep only their tool calls, so nothing appears twice (P5 review #13).
            assistants = [m for m in messages if m.role == "assistant"]
            for m in assistants:
                m.content = None
            if assistants:
                assistants[-1].content = heard
            else:
                messages.append(LlmMessage(role="assistant", content=heard))
            self._history.extend(messages)
            if spoken.heard:
                self._append_agent_line(turn.id, heard, True)
            return
        self._history.extend(messages)
        if spoken.text:
            self._append_agent_line(turn.id, spoken.text, False)

    def _append_agent_line(self, id_: str, text: str, interrupted: bool) -> None:
        self._dispatch_quietly(
            {
                "type": "AppendTranscript",
                "line": {
                    "id": id_,
                    "call_id": self._call_id,
                    "role": Role.AGENT,
                    "text": text,
                    "interrupted": interrupted,
                    "started_at": _utc(self._clock.now()),
                },
            }
        )

    async def _say_templated(self, text: str) -> None:
        """A templated line (reprompt, provider notice, goodbye): spoken and recorded like a turn, without the model."""
        if self._tts is None:
            return
        self._turn_gen += 1
        gen = self._turn_gen
        previous = self._turn
        if previous is not None:
            previous.abort.abort()
            await self._await_quietly(previous.running)
        if gen != self._turn_gen:
            return
        self._turn_count += 1
        turn_id = f"ta_{self._call_id}_{self._turn_count}"
        speech = SpeechTurn(turn_id, self._tts, self._clock, self._send)
        turn = _AgentTurn(turn_id, speech, None, None)
        self._turn = turn
        speech.say(text)
        speech.end()

        async def run() -> None:
            spoken = await self._played_out(turn)
            self._after_agent_turn(turn, spoken, [LlmMessage(role="assistant", content=text)])
            if spoken.characters > 0:
                self._spawn(self._port.record_tts_characters(spoken.characters))
            if self._turn is turn:
                self._turn = None

        turn.running = _eager(run())
        await turn.running

    async def _state(self, notes: list[ChatEventNote]) -> LlmMessage:
        ctx = await self._port.context(self._call_id)
        with_counts = [replace(note, rejections=self._rejections.get(note.field, 0)) for note in notes]
        return state_message(
            StateInput(
                now=_utc(self._clock.now()),
                call_started_at=self._started_at,
                session=ctx.session,
                fields=ctx.fields,
                requests=ctx.requests,
                is_returning_call=self._returning,
                last_agent_line=ctx.last_agent_line_before,
                new_chat_events=with_counts,
            )
        )

    # ---------------------------------------------------------------------------------------------------------------
    # Tools -> commands (exactly once each; the turn engine runs them in order)

    async def run_tool(self, call: ParsedToolCall) -> ToolOutcome:
        port = self._port
        args = call.args
        if call.name == "save_field":
            # Only what the customer really said (agent/grounding): a made-up value never reaches the session.
            said = [m.content or "" for m in self._history if m.role == "user"]
            ungrounded = grounding_error(args["spoken_evidence"], said)
            if ungrounded:
                return ToolOutcome(result={"status": "rejected", "error": ungrounded}, ok=False, quiet=True)
            command: dict[str, Any] = {
                "type": "SaveSpokenField",
                "field": args["field"],
                "value": args["value"],
                "evidence": args["spoken_evidence"],
            }
            if args.get("user_confirmed") is not None:
                command["user_confirmed"] = args["user_confirmed"]
            reply = await port.dispatch(command)
            field = args["field"]
            status = _reply_get(reply, "status")
            if status == "valid":
                return ToolOutcome(
                    result={"status": "valid"}, ok=True, ack=saved_ack(field, _reply_get(reply, "normalized"))
                )
            if status == "unverified":
                # Heard, but it must be typed (D13): the card goes to the chat at once.
                card = await port.dispatch({"type": "RequestInput", "field": field})
                card_status = _reply_get(card, "status")
                if card_status in ("queued", "alreadyPending"):
                    self._last_card_at = self._clock.now()
                return ToolOutcome(
                    result={"status": "heardButMustBeTyped", "chatCard": card_status or "unknown"},
                    ok=True,
                    ack=type_it_ack(field),
                )
            if status == "invalid":
                return ToolOutcome(result={"status": "invalid", "error": _reply_get(reply, "error")}, ok=False)
            reason = _reply_get(reply, "reason") if status == "refused" else "unknown"
            return ToolOutcome(result={"status": "refused", "reason": reason}, ok=False)
        if call.name == "request_chat_input":
            reply = await port.dispatch({"type": "RequestInput", "field": args["field"]})
            status = _reply_get(reply, "status")
            if status in ("queued", "alreadyPending"):
                self._last_card_at = self._clock.now()
                return ToolOutcome(result={"status": "sent"}, ok=True, ack=card_sent_ack(args["field"]))
            reason = _reply_get(reply, "reason") if status == "refused" else "unknown"
            return ToolOutcome(result={"status": "refused", "reason": reason}, ok=False)
        if call.name == "flag_for_review":
            await port.dispatch({"type": "FlagForReview", "kind": args["kind"], "reason": args["reason"]})
            return ToolOutcome(result={"status": "flagged"}, ok=True)
        if call.name == "opt_out":
            if not args["confirmed"]:
                return ToolOutcome(
                    result={"status": "confirmFirst", "note": "ask the customer to confirm they want to stop"}, ok=False
                )
            self._self_finalized = True
            reply = await port.dispatch({"type": "OptOutByCall"})
            if _reply_get(reply, "status") == "optedOut":
                return ToolOutcome(result={"status": "optedOut"}, ok=True, ack=OPTED_OUT_GOODBYE, end_call=True)
            # Refused (already submitted, say): the call goes on and the agent hears why (P5 review #17).
            self._self_finalized = False
            return ToolOutcome(
                result={"status": "refused", "reason": _reply_get(reply, "reason") or "unknown"}, ok=False
            )
        # end_call
        return ToolOutcome(result={"status": "ending"}, ok=True, end_call=True)

    # ---------------------------------------------------------------------------------------------------------------
    # Chat events (P5-T08)

    def _on_session_update(self, update: Any) -> None:
        if self._stopping:
            return
        for event in update.events:
            payload = event.payload if isinstance(event.payload, dict) else {}
            if event.type == "field.candidate" and event.channel == "chat":
                candidate = payload.get("candidate")
                candidate = candidate if isinstance(candidate, dict) else {}
                field = candidate.get("field")
                if not field or not is_record_field(field):
                    continue
                status = candidate.get("status")
                if status == "invalid":
                    self._rejections[field] = self._rejections.get(field, 0) + 1
                result: Any = "accepted" if status == "valid" else "skipped" if status == "skipped" else "rejected"
                self._note(ChatEventNote(field=field, result=result))
            elif event.type == "input.cancelled" and payload.get("reason") == "too many attempts":
                request = payload.get("request")
                field = request.get("field") if isinstance(request, dict) else None
                if field:
                    self._note(ChatEventNote(field=field, result="cancelled"))
            elif event.type in ("input.requested", "input.resumed"):
                self._last_card_at = self._clock.now()
            elif event.type == "session.finalized" and not self._self_finalized:
                # Finalized from the chat (Stop -> Yes, or Submit -> Yes) during the call: say so and end (P4-T05 -> P5-T09).
                self._spawn(self._goodbye_then_end(payload.get("outcome") == "optedOut"))

    async def _goodbye_then_end(self, opted_out: bool) -> None:
        await self._say_templated(OPTED_OUT_GOODBYE if opted_out else SUBMITTED_GOODBYE)
        await self._end("opted_out" if opted_out else "agent_ended", (CloseCode.NORMAL, "agent ended"))

    def _note(self, note: ChatEventNote) -> None:
        self._chat_seq += 1
        # One note per field: the latest outcome is what the agent should mention.
        self._pending = [n for n in self._pending if n.field != note.field] + [note]
        self._schedule_proactive()

    def _schedule_proactive(self) -> None:
        if self._proactive_timer is not None or self._stopping:
            return
        self._proactive_timer = self._clock.set_timeout(self._proactive_fired, self._t.proactive_idle_ms)

    def _proactive_fired(self) -> None:
        self._proactive_timer = None
        if self._stopping or not self._pending:
            return
        # Not while anyone is speaking or a turn is in flight; the notes then ride along with the next turn.
        if self._turn is not None or self._user_turns.speaking:
            return
        self._spawn(self._agent_turn(proactive=True))

    def _clear_proactive(self) -> None:
        if self._proactive_timer is not None:
            self._clock.clear_timeout(self._proactive_timer)
        self._proactive_timer = None

    # ---------------------------------------------------------------------------------------------------------------
    # Silence (P5-T10)

    def _arm_silence(self) -> None:
        self._clear_silence()
        if self._stopping:
            return
        self._silence_timer = self._clock.set_timeout(self._silence_fired, self._t.silence_ms)

    def _silence_fired(self) -> None:
        self._silence_timer = None
        self._spawn(self._on_silence())

    def _clear_silence(self) -> None:
        if self._silence_timer is not None:
            self._clock.clear_timeout(self._silence_timer)
        self._silence_timer = None

    async def _on_silence(self) -> None:
        if self._stopping or self._turn is not None or self._user_turns.speaking:
            return
        if self._clock.now() - self._last_card_at < self._t.card_suspend_ms:
            self._arm_silence()  # they're probably looking for the serial number or typing
            return
        self._reprompts += 1
        if self._reprompts > self._t.silence_reprompts:
            await self._end("silence", (CloseCode.NORMAL, "silence"))
            return
        await self._say_templated(REPROMPTS[min(self._reprompts, len(REPROMPTS)) - 1])
        self._arm_silence()

    # ---------------------------------------------------------------------------------------------------------------
    # TTS and the end

    def _on_tts(self, event: TtsEvent) -> None:
        if isinstance(event, TtsAudio | TtsFlushed):
            if self._turn is not None and self._turn.id == event.turn_id:
                self._turn.speech.on_tts(event)
            return
        if isinstance(event, TtsError) and not self._stopping:
            # The adapter already retried once. The words go to the chat instead, and the call ends (failure matrix).
            self._log.error("TTS failed; ending the call", message=str(event.error))
            # The current turn's words (it isn't in the history yet, P5 review #14).
            text = self._turn.speech.text if self._turn is not None else ""
            if text:
                self._dispatch_quietly({"type": "AgentSays", "text": text})
            self._spawn(self._end("provider_error", (CloseCode.NORMAL, "call ended")))

    def _dispatch_quietly(self, command: dict[str, Any]) -> None:
        async def run() -> None:
            try:
                await self._port.dispatch(command)
            except Exception as err:
                self._log.error("call command failed", command=command["type"], message=str(err))

        self._spawn(run())

    def _end(self, reason: CallEndReason, close: tuple[int, str] | None) -> asyncio.Future[None]:
        """Ends the call exactly once: timers, speech, providers, the ledger, EndCall, then the socket."""
        if self._ending is not None:
            return self._ending
        self._stopping = True
        self._ending = _eager(self._do_end(reason, close))
        return self._ending

    async def _do_end(self, reason: CallEndReason, close: tuple[int, str] | None) -> None:
        self._clear_silence()
        self._clear_proactive()
        if self._barge_timer is not None:
            self._clock.clear_timeout(self._barge_timer)
        for timer in self._timers:
            self._clock.clear_timeout(timer)
        if self._unsubscribe is not None:
            self._unsubscribe()
        turn = self._turn
        if turn is not None and turn.speech.speaking and reason not in ("agent_ended", "opted_out"):
            turn.abort.abort()
            turn.speech.cancel()
        elif turn is not None:
            turn.abort.abort()
        self._user_turns.flush()

        # EndCall first (the chat takes over at once, P5-T09 <= 1 s), the providers' closes alongside (P5 review #10).
        async def end_call() -> None:
            try:
                await self._port.dispatch({"type": "EndCall", "call_id": self._call_id, "reason": reason})
            except Exception as err:
                self._log.error("EndCall failed", message=str(err))

        await asyncio.gather(
            end_call(),
            self._stt.close() if self._stt is not None else _nothing(),
            self._tts.close() if self._tts is not None else _nothing(),
            return_exceptions=True,
        )
        seconds = math.floor((self._stt_bytes / MIC_BYTES_PER_SECOND) * 100 + 0.5) / 100
        self._spawn(self._port.record_stt_seconds(seconds))
        self._log.info(
            "call ended",
            reason=reason,
            seconds=round((self._clock.now() - self._started_at) / 1000),
            barge_ins=self.barge_ins,
        )
        if close is not None:
            self._close(close[0], close[1])
        if not self._ended.done():
            self._ended.set_result(None)


class _Tools:
    """The ToolRunner handed to the turn engine."""

    def __init__(self, engine: CallEngine) -> None:
        self._engine = engine

    async def run(self, call: ParsedToolCall) -> ToolOutcome:
        return await self._engine.run_tool(call)

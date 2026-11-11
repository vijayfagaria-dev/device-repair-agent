"""The LLM turn engine (P5-T06).

One agent turn = up to MAX_ROUNDS model calls. Each call streams text to the speech sink as it arrives and collects tool
calls; tool calls are validated (tools.py) and run through the ToolRunner, which dispatches commands, exactly once each;
all results go back in one message.

Acknowledge-then-ask (D13, P0-T03): gpt-oss-20b usually answers with tool calls and no speech, often one field per call
(P5-T01 capture). Then a templated acknowledgement built from the validated results is spoken at once and recorded as
the agent's words, and the next call runs for the next question while it plays. A follow-up call only happens when
nothing was said yet or a result was invalid (so the agent can react); otherwise the turn ends.
Failures: the router has already tried every route (agent/llm.py); then a filler line is said and the turn is marked
failed (the call engine ends the call after two in a row). Empty or refused output also counts as refused.
"""

from __future__ import annotations

import contextlib
import json
import re
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

from app.agent.speech_filter import SpeechFilter
from app.agent.tools import TOOLS, ParsedToolCall, parse_tool_call
from app.voice.types import (
    AbortSignal,
    ChatToolCall,
    DoneChunk,
    LlmClient,
    LlmError,
    LlmMessage,
    LlmRequest,
    LlmRoute,
    LlmUsage,
    TextChunk,
    ToolCallChunk,
    UsageChunk,
)

MAX_ROUNDS = 4
FILLER_LINE = "Sorry, give me a moment. Could you say that again?"
#: Said first when the last-resort route (Gemini) answers, which is slower (D06).
ONE_MOMENT = "One moment."

_TRAILING_SPACE = re.compile(r"\s$")
_LEADING_SPACE = re.compile(r"^\s")


@dataclass(slots=True)
class ToolOutcome:
    #: What the model is told (JSON).
    result: dict[str, Any]
    #: The call did what was asked. False (invalid value, refused card, needs confirmation) -> a follow-up call.
    ok: bool
    #: A short templated acknowledgement of a validated result ("Got it, Samsung Galaxy S23.").
    ack: str | None = None
    #: A rejection the customer needs no reaction to (a made-up value refused): never worth a follow-up that speaks again.
    quiet: bool = False
    #: The call ends after this turn's speech (end_call, opt-out).
    end_call: bool = False


class ToolRunner(Protocol):
    async def run(self, call: ParsedToolCall) -> ToolOutcome: ...


class TurnSink(Protocol):
    def say(self, text: str) -> None: ...

    def break_chunk(self) -> None:
        """Speak what has been said so far now, without waiting for more text (a templated line ends here)."""
        ...


@dataclass(slots=True)
class TurnInput:
    #: System prompt and this call's conversation so far (no state message).
    history: Sequence[LlmMessage]
    #: A fresh state message for each model call (tool results may have changed it).
    state: Callable[[], Awaitable[LlmMessage]]
    signal: AbortSignal | None = None
    #: True once a chat event arrived that this turn's state does not contain. The model's text was written from an older
    #: state and would be stale when spoken: it is dropped, and the event gets its own turn with fresh state (call
    #: engine: pending notes -> proactive turn). Acknowledgements built from validated results are still spoken.
    is_stale: Callable[[], bool] | None = None


@dataclass(slots=True)
class RoundRecord:
    route: LlmRoute
    usage: LlmUsage | None = None
    ttft_ms: int | None = None


@dataclass(slots=True)
class TurnOutput:
    #: Everything said, in order (model text and acknowledgements).
    spoken: str = ""
    #: What to append to the call's history: assistant messages (with tool calls) and tool results.
    messages: list[LlmMessage] = field(default_factory=list)
    rounds: list[RoundRecord] = field(default_factory=list)
    end_call: bool = False
    #: No route answered: the filler line was said.
    failed: bool = False
    #: The model gave empty or refused output.
    refused: bool = False
    aborted: bool = False
    #: Tool calls run, by name (for tests and the timeline).
    tools_run: list[str] = field(default_factory=list)


@dataclass(slots=True)
class TurnDeps:
    llm: LlmClient
    tools: ToolRunner
    #: Each model call as it ends (usage None: aborted before the provider reported it). For the ledger, at once.
    on_round: Callable[[LlmRoute, LlmUsage | None], None] | None = None


async def run_turn(deps: TurnDeps, input: TurnInput, sink: TurnSink) -> TurnOutput:
    out = TurnOutput()
    signal = input.signal

    def aborted() -> bool:
        return signal is not None and signal.aborted

    def stale() -> bool:
        return input.is_stale is not None and input.is_stale()

    def say(text: str) -> None:
        """Speaks text, separated from what was said before it."""
        if not text:
            return
        piece = (
            f" {text}"
            if out.spoken and not _TRAILING_SPACE.search(out.spoken) and not _LEADING_SPACE.match(text)
            else text
        )
        sink.say(piece)
        out.spoken += piece

    last_ack = ""
    # The acknowledgement the previous round spoke: a follow-up that starts by repeating it has that part dropped.
    just_said = ""
    # A stream that broke mid-way gets one more round, told where it was cut off (a dead line is worse than a retry).
    retried_break = False
    # The model has asked the customer something this turn: no follow-up round runs to ask again (live: the same question
    # was asked three times, because failed tool calls after it started more rounds). Nothing is cut from what it says.
    asked = False
    hint: LlmMessage | None = None

    for _round in range(MAX_ROUNDS):
        if aborted():
            out.aborted = True
            break
        messages = [*input.history, *out.messages, *([hint] if hint else []), await input.state()]
        hint = None

        def on_fallback(nxt: LlmRoute) -> None:
            # The last resort (Gemini) is slower: say so while it works, not after it answered (D06).
            if nxt.provider == "gemini" and not out.spoken:
                say(ONE_MOMENT)
                sink.break_chunk()

        try:
            stream = await deps.llm.stream(
                LlmRequest(messages=messages, tools=list(TOOLS), signal=signal, on_fallback=on_fallback)
            )
        except Exception as err:
            error = err if isinstance(err, LlmError) else LlmError(str(err), None)
            if error.status == "aborted" or aborted():
                out.aborted = True
                break
            out.refused = error.status == "empty"
            # Something was already said this turn: end it there. Otherwise the filler keeps the call alive.
            if not out.spoken:
                out.failed = True
                say(FILLER_LINE)
                out.messages.append(LlmMessage(role="assistant", content=FILLER_LINE))
            break
        record = RoundRecord(route=stream.route)
        out.rounds.append(record)

        text = ""
        calls: list[ChatToolCall] = []
        finish_reason: str | None = None
        broke = False
        # Held back while it could still be a repeat of `just_said` (real gpt-oss-20b runs did repeat it despite the prompt).
        held: str | None = "" if just_said else None
        # Prompt markup, invisible characters and runaway filler never reach the speaker (speech_filter.py).
        speech_filter = SpeechFilter()
        prefix = just_said.lower()

        def speak(delta: str) -> None:
            nonlocal text, asked
            if not delta or stale():
                return
            if "?" in delta:
                asked = True
            # Only the round's first piece is separated from earlier speech; later pieces are mid-word tokens.
            if text == "":
                say(delta.lstrip())
            else:
                sink.say(delta)
                out.spoken += delta
            text += delta.lstrip() if text == "" else delta

        def emit(raw: str, flt: SpeechFilter = speech_filter) -> None:
            speak(flt.push(raw))

        def release(final: bool, prefix: str = prefix) -> None:
            nonlocal held
            if held is None:
                return
            lead = held.lstrip()
            if lead.lower().startswith(prefix):
                held = None
                emit(lead[len(prefix) :])
            elif final or not prefix.startswith(lead.lower()):
                everything = held
                held = None
                emit(everything)

        try:
            async for chunk in stream:
                if aborted():
                    break
                if speech_filter.degenerate:
                    break  # the model is looping on filler: stop reading, keep what was said
                if isinstance(chunk, TextChunk):
                    if held is not None:
                        held += chunk.delta
                        release(False)
                    else:
                        emit(chunk.delta)
                elif isinstance(chunk, ToolCallChunk):
                    calls.append(chunk.call)
                elif isinstance(chunk, UsageChunk):
                    record.usage = chunk.usage
                elif isinstance(chunk, DoneChunk):
                    finish_reason = chunk.finish_reason
        except Exception:
            # A stream that broke mid-way: keep what was said (a retry below), never leave the line silent.
            broke = True
            out.failed = out.spoken == "" and text == ""
        finally:
            aclose = getattr(stream, "aclose", None)
            if aclose is not None:
                with contextlib.suppress(Exception):
                    await aclose()
        release(True)
        speak(speech_filter.flush())
        just_said = ""
        record.ttft_ms = stream.ttft_ms
        if deps.on_round is not None:
            deps.on_round(record.route, record.usage)
        if aborted():
            out.aborted = True
            if text or calls:
                out.messages.append(LlmMessage(role="assistant", content=text or None))
            break
        if broke and not calls and not retried_break:
            retried_break = True
            out.failed = False
            if text.strip():
                out.messages.append(LlmMessage(role="assistant", content=text))
                hint = LlmMessage(
                    role="system",
                    content=f'Your last reply was cut off after "{text.strip()[-80:]}". Finish it in one short sentence, without repeating what you already said.',
                )
            continue
        if finish_reason == "content_filter" and not text and not calls:
            out.refused = True

        if not calls:
            if text.strip():
                out.messages.append(LlmMessage(role="assistant", content=text))
            elif stale():
                break  # its text was dropped as stale: not a failure, the chat event gets its own turn
            elif not out.spoken:
                out.refused = True
                out.failed = True
                say(FILLER_LINE)
                out.messages.append(LlmMessage(role="assistant", content=FILLER_LINE))
            break

        # Each call is run exactly once, in order; invalid ones get an error result and no effect.
        outcomes: list[ToolOutcome] = []
        for call in calls:
            parsed = parse_tool_call(call.name, call.arguments)
            if not parsed.ok or parsed.call is None:
                outcomes.append(ToolOutcome(result={"status": "error", "error": parsed.error}, ok=False))
                continue
            out.tools_run.append(parsed.call.name)
            outcomes.append(await deps.tools.run(parsed.call))
        content: str | None = text if text.strip() else None
        if not content:
            acks = list(dict.fromkeys(o.ack for o in outcomes if o.ok and o.ack))[:2]
            ack = " ".join(acks) if all(o.ok for o in outcomes) else ""
            if ack and ack != last_ack:
                say(ack)
                sink.break_chunk()  # spoken now, while the follow-up call runs (acknowledge-then-ask)
                last_ack = ack
                just_said = ack
                content = ack
        out.messages.append(LlmMessage(role="assistant", content=content, tool_calls=list(calls)))
        for call, outcome in zip(calls, outcomes, strict=True):
            out.messages.append(LlmMessage(role="tool", tool_call_id=call.id, content=_json(outcome.result)))
        if any(o.end_call for o in outcomes):
            out.end_call = True
            break
        # A follow-up round exists to ask the next question or to react to an invalid value. It does not run after the model
        # already asked something, or once the turn's state went stale (the chat event gets its own turn).
        need_follow_up = (
            not asked and not stale() and (not text.strip() or any(not o.ok and not o.quiet for o in outcomes))
        )
        if not need_follow_up:
            break
    return out


def _json(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)

"""The session services one server process shares: the hub (live fan-out) and the command processor (the single writer),
with every command handler and the post-commit reactions."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from app.domain.record import without_file_urls

from .commands import CommandProcessor, TimerSettings
from .handlers.call import (
    AgentSays,
    AppendTranscript,
    EndCall,
    FlagForReview,
    OptOutByCall,
    SaveSpokenField,
    StartCall,
    agent_says_handler,
    append_transcript_handler,
    end_call_handler,
    flag_for_review_handler,
    opt_out_by_call_handler,
    save_spoken_field_handler,
    start_call_handler,
)
from .handlers.chat_input import OptOutRequested, SubmitChatInput
from .handlers.finalize import Finalize, FinalizeDeps, finalize_handler, finalize_prepare
from .handlers.opt_out import opt_out_handler
from .handlers.request_input import (
    Reconcile,
    RequestInput,
    reconcile_handler,
    reconcile_reaction,
    request_input_handler,
)
from .handlers.submit_chat_input import submit_chat_input_handler, submit_chat_input_prepare
from .handlers.timers import TimerFired, timer_fired_handler, timer_fired_prepare
from .hub import SessionHub

DEFAULT_TIMER_SETTINGS = TimerSettings(
    idle_timeout_ms=15 * 60 * 1000,  # PD3: 15 minutes
    session_lifetime_ms=7 * 24 * 60 * 60 * 1000,  # PD3a: 7 days
)


@dataclass(slots=True)
class SessionServices:
    hub: SessionHub
    processor: CommandProcessor


def _no_file_urls(file_id: str, now: datetime) -> str:
    """Used when no signer is configured (tests that never finalize a file): a record with a file can't be built."""
    raise RuntimeError("file URL signing is not configured")


def create_session_services(
    *,
    pool: Any,
    log: Any,
    timers: TimerSettings | None = None,
    now: Callable[[], datetime] | None = None,
    sign_file_url: Callable[[str, datetime], str] | None = None,
    auto_complete_on_idle: bool = True,
    planner: bool = True,
    failpoint: Callable[[str], Awaitable[None] | None] | None = None,
    on_outbox_queued: Callable[[], None] | None = None,
) -> SessionServices:
    """`sign_file_url`: signs the file links a record carries (``FileUrlSigner.sign``). `auto_complete_on_idle`:
    AUTO_COMPLETE_ON_IDLE (D16). `planner`: runs the chat planner after every command (P4-T01); on in production, tests
    of the transport alone turn it off so their scripted cards aren't joined by the planner's. `failpoint`: a crash
    point inside the command transaction, for tests (commands.py); production never sets it. `on_outbox_queued`: told
    after a command committed a record, so the outbox worker delivers it at once (P7-T03)."""
    hub = SessionHub(log)
    processor = CommandProcessor(
        pool=pool,
        hub=hub,
        log=log,
        timers=timers or DEFAULT_TIMER_SETTINGS,
        now=now,
        failpoint=failpoint,
        on_outbox_queued=on_outbox_queued,
    )
    deps = FinalizeDeps(sign_file_url=sign_file_url or _no_file_urls, auto_complete_on_idle=auto_complete_on_idle)

    processor.register("TimerFired", timer_fired_handler(deps), prepare=timer_fired_prepare, command_class=TimerFired)
    processor.register(
        "SubmitChatInput",
        submit_chat_input_handler(deps),
        prepare=submit_chat_input_prepare,
        command_class=SubmitChatInput,
    )
    processor.register("OptOutRequested", opt_out_handler, command_class=OptOutRequested)
    processor.register("Finalize", finalize_handler(deps), prepare=finalize_prepare, command_class=Finalize)
    processor.register("Reconcile", reconcile_handler, command_class=Reconcile)
    processor.register("RequestInput", request_input_handler, command_class=RequestInput)
    # The call (P5): lifecycle, transcript and the agent's tools.
    processor.register("StartCall", start_call_handler, command_class=StartCall)
    processor.register("EndCall", end_call_handler, command_class=EndCall)
    processor.register("AppendTranscript", append_transcript_handler, command_class=AppendTranscript)
    processor.register("AgentSays", agent_says_handler, command_class=AgentSays)
    processor.register("SaveSpokenField", save_spoken_field_handler, command_class=SaveSpokenField)
    processor.register("FlagForReview", flag_for_review_handler, command_class=FlagForReview)
    processor.register(
        "OptOutByCall", opt_out_by_call_handler(deps), prepare=finalize_prepare, command_class=OptOutByCall
    )

    # Delivery is just this log line until the outbox worker (P7-T03): the brief allows logging the record. Without the
    # signed file links: they are bearer URLs for 30 days, and logs are read more widely than records (P4 review #8).
    def log_record(session_id: str, update: Any, command: Any) -> None:
        if update is None or update.record is None:
            return
        finalized = next((e for e in update.events if e.type == "session.finalized"), None)
        if finalized is not None and finalized.payload.get("schemaProblems"):
            # R-5: a record that broke its own schema is a bug (D17); paths and keywords only, never values.
            log.error(
                "record failed its schema; finalized as needsReview",
                session_id=session_id,
                revision=update.record["revision"],
                problems=finalized.payload["schemaProblems"],
            )
        log.info(
            "record produced",
            session_id=session_id,
            revision=update.record["revision"],
            record=without_file_urls(update.record["payload"]),
        )

    processor.add_reaction(log_record)
    if planner:
        processor.add_reaction(reconcile_reaction(processor))
    return SessionServices(hub=hub, processor=processor)

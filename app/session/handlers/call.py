"""The call's commands (P5-T02, P5-T05/T06 tools): every state change a call makes goes through the processor, like chat's.

StartCall/EndCall happen exactly once per call; the transcript keeps final lines only (D12); spoken values are
validated by code, never trusted from the model (D13), and identifiers heard aloud are only ``unverified``.
Replies are dicts with the TS key names.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, ClassVar

from app.agent.chat_planner import next_request_id, open_card_drafts
from app.agent.chat_templates import RESUME_PROMPT, ControlField, call_ended_message, resume_card
from app.domain.dates import ist_today
from app.domain.fields import FIELDS
from app.domain.outcome import ReviewFlag
from app.domain.validators.chat_fields import validate_email, validate_serial_number, validate_service_centre
from app.domain.validators.result import ValidationResult
from app.domain.validators.voice_fields import (
    validate_device_model,
    validate_device_type,
    validate_problem_description,
    validate_problem_started_at,
    validate_urgency,
)
from app.protocol.enums import FieldSource, Role
from app.session.commands import CallEffect, Effects, EventDraft, Handler, TimerEffects
from app.session.ids import new_message_id
from app.session.snapshot import Snapshot

from .finalize import FinalizeDeps, FinalizeOptions, finalize_effects
from .reopen import reopened_snapshot, with_reopen

#: Why a call ended (call.ended reason; protocol.md section 6 close reasons map onto these):
#: hangup | agent_ended | network | silence | max_duration | provider_error | server_restart | opted_out
CallEndReason = str


@dataclass(frozen=True, slots=True)
class StartCall:
    type: ClassVar[str] = "StartCall"
    call_id: str


def start_call_handler(snapshot: Snapshot, command: StartCall) -> Effects:
    """A new call is explicit user activity (D16): on a finalized session it reopens it (P7-T05). After an opt-out the
    call is refused and the chat gets "Resume your claim?" first; the user calls again once they said Yes.

    Replies: ``{"status": "started", "returning": bool}`` or ``{"status": "refused", "reason": "active" | "closed" | "resumeRequired"}``.
    """
    if snapshot.session.status == "finalized":
        reopened = reopened_snapshot(snapshot, "callStarted")
        if reopened is not None:
            return with_reopen(snapshot, "callStarted", _start_active_call(reopened, command))
        if snapshot.session.outcome == "optedOut":
            pending = any(r.field == ControlField.RESUME and r.status in ("open", "queued") for r in snapshot.requests)
            events = (
                []
                if pending
                else open_card_drafts(
                    next_request_id(snapshot, ControlField.RESUME), ControlField.RESUME, resume_card(), RESUME_PROMPT
                )
            )
            return Effects(events=events, reply={"status": "refused", "reason": "resumeRequired"})
    return _start_active_call(snapshot, command)


def _start_active_call(snapshot: Snapshot, command: StartCall) -> Effects:
    if snapshot.session.status != "active":
        return Effects(reply={"status": "refused", "reason": "closed"})
    if snapshot.session.active_call_id is not None:
        return Effects(reply={"status": "refused", "reason": "active"})
    returning = len(snapshot.calls) > 0
    return Effects(
        call=CallEffect(start={"id": command.call_id, "started_at": snapshot.now}),
        session={"active_call_id": command.call_id},
        events=[
            EventDraft(type="call.started", channel="call", payload={"callId": command.call_id, "returning": returning})
        ],
        timers=TimerEffects(clear=["noCallStart"]),
        activity=True,  # a new call is explicit user activity (D16)
        reply={"status": "started", "returning": returning},
    )


@dataclass(frozen=True, slots=True)
class EndCall:
    type: ClassVar[str] = "EndCall"
    call_id: str
    reason: CallEndReason


def end_call_handler(snapshot: Snapshot, command: EndCall) -> Effects:
    """Reply: ``{"status": "ended", "seconds": int}`` or ``{"status": "notActive"}``."""
    # Exactly once: only the call that is active ends it; a second end (another close path) is a no-op.
    if snapshot.session.active_call_id != command.call_id:
        return Effects(reply={"status": "notActive"})
    call = next((c for c in snapshot.calls if c.id == command.call_id), None)
    seconds = max(0, math.floor((snapshot.now - call.started_at).total_seconds() + 0.5)) if call else 0
    events = [
        EventDraft(
            type="call.ended",
            channel="call",
            payload={"callId": command.call_id, "reason": command.reason, "seconds": seconds},
        )
    ]
    # A reason-specific note for ends the user didn't choose (P5-T09); after an ordinary hang-up the planner's
    # "Thanks for the call..." lead-in says it with the next card.
    note = call_ended_message(command.reason)
    if note:
        events.append(
            EventDraft(
                type="chat.message",
                channel="chat",
                chat_message={"id": new_message_id(), "role": Role.AGENT, "text": note},
            )
        )
    return Effects(
        call=CallEffect(end={"id": command.call_id, "reason": command.reason, "ended_at": snapshot.now}),
        session={"active_call_id": None},
        events=events,
        reply={"status": "ended", "seconds": seconds},
    )


@dataclass(frozen=True, slots=True)
class AppendTranscript:
    type: ClassVar[str] = "AppendTranscript"
    #: id, call_id, role, text, started_at, interrupted?
    line: dict[str, Any]


def append_transcript_handler(snapshot: Snapshot, command: AppendTranscript) -> Effects:
    """Reply: ``{"appended": bool}``."""
    line = command.line
    if not any(c.id == line["call_id"] for c in snapshot.calls) or not str(line["text"]).strip():
        return Effects(reply={"appended": False})
    return Effects(
        events=[EventDraft(type="transcript.final", channel="call", transcript_line=dict(line))],
        reply={"appended": True},
    )


@dataclass(frozen=True, slots=True)
class SaveSpokenField:
    type: ClassVar[str] = "SaveSpokenField"
    field: str
    value: str
    evidence: str
    user_confirmed: bool = False


def validate_spoken(snapshot: Snapshot, field: str, value: str, evidence: str) -> ValidationResult[Any]:
    """Validates what was heard for a field (D14), from the model's value and the customer's words."""
    if field == "deviceType":
        return validate_device_type(value)
    if field == "deviceModel":
        # "Don't know" is asked again once, then accepted as unknown (D14).
        tried_before = any(
            c.field == "deviceModel" and c.source == "call" and c.status == "invalid" for c in snapshot.candidates
        )
        return validate_device_model(value, allow_unknown=tried_before)
    if field == "problemDescription":
        return validate_problem_description({"summary": value, "verbatim": evidence or value})
    if field == "problemStartedAt":
        # The customer's words decide (relative dates are resolved in code, P0-T03), the model's value only if none.
        return validate_problem_started_at(
            {"spoken": evidence, "date": value} if evidence.strip() else value, today=ist_today(snapshot.now)
        )
    if field == "urgency":
        return validate_urgency({"level": value, "reason": evidence})
    if field == "serviceCentre":
        return validate_service_centre(value, spoken=True)
    if field == "serialNumber":
        return validate_serial_number(value)
    if field == "email":
        return validate_email(value)
    return ValidationResult("invalid", error="That needs the chat card.")


def save_spoken_field_handler(snapshot: Snapshot, command: SaveSpokenField) -> Effects:
    """Reply: ``{"status": "valid"|"unverified", "normalized"}``, ``{"status": "invalid", "error"}`` or
    ``{"status": "refused", "reason": "notSpoken"|"notActive"}``."""
    if snapshot.session.status != "active":
        return Effects(reply={"status": "refused", "reason": "notActive"})
    field = command.field
    if field not in FIELDS or not FIELDS[field].spoken_capture:
        return Effects(reply={"status": "refused", "reason": "notSpoken"})
    result = validate_spoken(snapshot, field, command.value, command.evidence)
    # An identifier heard aloud is noted but never accepted: it must be typed (D13).
    chat_only = FIELDS[field].authority == "chatOnly"
    status = ("unverified" if chat_only else "valid") if result.status == "valid" else "invalid"
    normalized = result.normalized if result.status == "valid" else None
    error = result.error if result.status == "invalid" else None
    return Effects(
        events=[
            EventDraft(
                type="field.candidate",
                channel="call",
                candidate={
                    "field": field,
                    "source": FieldSource.CALL,
                    # The model's value only: its quote of the transcript (evidence) stays in the candidate row, out of
                    # the event payload and so out of the timeline (D12, commands.py).
                    "raw": command.value,
                    "normalized": normalized,
                    "status": status,
                    "error": error,
                    "user_confirmed": command.user_confirmed is True,
                    "evidence": command.evidence,
                },
            )
        ],
        activity=True,
        reply=(
            {"status": status, "error": error or "That didn't sound right."}
            if status == "invalid"
            else {"status": status, "normalized": normalized}
        ),
    )


@dataclass(frozen=True, slots=True)
class FlagForReview:
    type: ClassVar[str] = "FlagForReview"
    kind: str  # "safety" | "other"
    reason: str


def flag_for_review_handler(snapshot: Snapshot, command: FlagForReview) -> Effects:
    """Reply: ``{"status": "flagged" | "alreadyFlagged" | "notActive"}``."""
    if snapshot.session.status != "active":
        return Effects(reply={"status": "notActive"})
    flag = ReviewFlag(rule="R-1" if command.kind == "safety" else "R-5", reason=command.reason[:300])
    existing = snapshot.session.review_flags
    if any(f.get("rule") == flag.rule and f.get("reason") == flag.reason for f in existing):
        return Effects(reply={"status": "alreadyFlagged"})
    return Effects(
        session={"review_flags": [*existing, {"rule": flag.rule, "reason": flag.reason}]},
        events=[EventDraft(type="review.flagged", channel="call", payload={"rule": flag.rule, "reason": flag.reason})],
        reply={"status": "flagged"},
    )


@dataclass(frozen=True, slots=True)
class OptOutByCall:
    type: ClassVar[str] = "OptOutByCall"


def opt_out_by_call_handler(deps: FinalizeDeps) -> Handler:
    """Reply: ``{"status": "optedOut", "revision"}`` or ``{"status": "refused", "reason"}``."""

    def handle(snapshot: Snapshot, command: OptOutByCall) -> Effects:
        result = finalize_effects(snapshot, FinalizeOptions(trigger="optOutConfirmed", submit_confirmed_at=None), deps)
        if not result.finalized or result.effects is None:
            return Effects(reply={"status": "refused", "reason": result.reason})
        e = result.effects
        return Effects(
            events=[EventDraft(type="optout.confirmed", channel="call"), *e.events],
            session=e.session,
            record=e.record,
            timers=e.timers,
            reply={"status": "optedOut", "revision": result.revision},
        )

    return handle


@dataclass(frozen=True, slots=True)
class AgentSays:
    type: ClassVar[str] = "AgentSays"
    text: str


def agent_says_handler(snapshot: Snapshot, command: AgentSays) -> Effects:
    """An agent line in the chat (the failure matrix: the voice failed, so the words go to the chat instead).
    Reply: ``{"said": bool}``."""
    clean = command.text.strip()[:2000]
    if not clean:
        return Effects(reply={"said": False})
    return Effects(
        events=[
            EventDraft(
                type="chat.message",
                channel="chat",
                chat_message={"id": new_message_id(), "role": Role.AGENT, "text": clean},
            )
        ],
        reply={"said": True},
    )

"""SubmitChatInput (P4-T02): the user's answer to a chat card.

The request must be the session's open card and the field must match; the value is validated on the server (the
client's card is only a hint) -> a candidate is appended (valid, invalid or skipped) -> accepted (the user's answer and
an agent acknowledgement as chat messages) or rejected (inputError, the card stays open); the third invalid answer
cancels the card, the field stays invalid with attempts = 3 (D14) and the planner moves on.
- An answer to a card already answered is the same result again: nothing is written (a double send).
- A card that isn't open (cancelled, never sent, another session's): "This request is no longer active."
- ``file:`` refs must name uploads of this session.
- A closed session takes no answers. A finalized session reopens when the answer is to a card it kept open (a
  ``partial`` session's, P7-T05); an opted-out one only through "Resume your claim?".
Control cards (protocol.md section 5): Yes on "Submit claim?" finalizes in this same command (confirmSubmit); No opens the
"What would you like to change?" card, whose answer re-asks that field. Yes on "Stop your claim?" finalizes as
optedOut; No lets the planner bring back the card the Stop flow paused.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.agent.chat_planner import cancel_draft, is_record_field, next_request_id, open_card_drafts
from app.agent.chat_templates import (
    RESUME_ACCEPTED_MESSAGE,
    RESUME_DECLINED_MESSAGE,
    RESUME_MESSAGE,
    STILL_MISSING_MESSAGE,
    ControlField,
    acknowledgement,
    answer_text,
    edit_card,
    edit_lead_in,
    too_many_attempts,
)
from app.db.repos.files import list_files
from app.db.repos.input_requests import StoredInputRequest
from app.db.tx import Tx
from app.domain.dates import ist_today
from app.domain.fields import FIELDS, MAX_ATTEMPTS
from app.domain.validators.chat_fields import (
    validate_additional_notes,
    validate_email,
    validate_serial_number,
    validate_service_centre,
    validate_submit_confirmation,
)
from app.domain.validators.files import validate_file_selection
from app.domain.validators.result import ValidationResult, invalid, valid
from app.domain.validators.voice_fields import (
    validate_device_model,
    validate_device_type,
    validate_problem_description,
    validate_problem_started_at,
    validate_urgency,
)
from app.protocol.enums import FieldSource, Role
from app.session.commands import Effects, EventDraft, Handler
from app.session.ids import new_message_id
from app.session.snapshot import Snapshot, SnapshotExtras, resolve_fields

from .chat_input import STALE_REQUEST_MESSAGE, SubmitChatInput
from .finalize import FinalizeDeps, FinalizeOptions, finalize_effects, finalize_extras
from .reopen import reopened_snapshot, with_reopen

CLOSED_SESSION_MESSAGE = "This claim has already been submitted, so it can't be changed here."
WRONG_FIELD_MESSAGE = "This answer doesn't match the question. Please try again."

_FILE_FIELDS = frozenset(["purchaseInvoice", "additionalPhotos"])


def _agent_says(text: str) -> EventDraft:
    return EventDraft(
        type="chat.message", channel="chat", chat_message={"id": new_message_id(), "role": Role.AGENT, "text": text}
    )


def _chosen(spec: dict[str, Any], value: Any) -> str | None:
    """A select card's value must be one of the options the server sent (D14: the client list is never trusted)."""
    if isinstance(value, str) and any(option.get("value") == value for option in spec.get("options") or []):
        return value
    return None


@dataclass(slots=True)
class _Checked:
    result: ValidationResult[Any]
    #: Display names of the files answered (for the answer bubble).
    file_names: list[str] = field(default_factory=list)


def _check_field_answer(snapshot: Snapshot, request: StoredInputRequest, field_id: str, value: Any) -> _Checked:
    """Validates an answer to a record field's card (D14). Never trusts the card: options and files are re-checked."""
    spec = request.spec
    if field_id == "deviceType":
        option = _chosen(spec, value)
        return _Checked(validate_device_type(option) if option else invalid("Please choose one of the options."))
    if field_id == "urgency":
        option = _chosen(spec, value)
        return _Checked(validate_urgency(option) if option else invalid("Please choose one of the options."))
    if field_id == "deviceModel":
        # "Don't know" is re-asked once, then accepted as unknown (D14).
        return _Checked(validate_device_model(value, allow_unknown=request.attempts >= 1))
    if field_id == "problemDescription":
        return _Checked(validate_problem_description(value))
    if field_id == "problemStartedAt":
        if isinstance(value, str):
            return _Checked(validate_problem_started_at(value, today=ist_today(snapshot.now)))
        return _Checked(invalid("Please choose a valid date."))
    if field_id == "serialNumber":
        return _Checked(validate_serial_number(value))
    if field_id == "serviceCentre":
        return _Checked(validate_service_centre(value))
    if field_id == "email":
        return _Checked(validate_email(value))
    if field_id == "additionalNotes":
        return _Checked(validate_additional_notes(value))
    if field_id in _FILE_FIELDS:
        selection = validate_file_selection(field_id, value)  # type: ignore[arg-type]
        if selection.status != "valid":
            return _Checked(selection)
        owned = {f.id: f for f in snapshot.files or []}
        found = [owned.get(file_id) for file_id in selection.normalized or []]
        # Another session's file id looks exactly like an unknown one: nothing about it is revealed.
        if any(f is None for f in found):
            return _Checked(invalid("That upload wasn't recognised. Please upload the file again."))
        stored = [f for f in found if f is not None]
        if field_id == "additionalPhotos" and any(not f.mime.startswith("image/") for f in stored):
            return _Checked(invalid("Photos must be JPEG, PNG or WebP images."))
        descriptors = [{"fileId": f.id, "mime": f.mime, "size": f.size, "sha256": f.sha256} for f in stored]
        return _Checked(
            valid(descriptors[0] if field_id == "purchaseInvoice" else descriptors),
            [f.original_name or "file" for f in stored],
        )
    raise ValueError(f"not a record field: {field_id}")


def _answered_drafts(request: StoredInputRequest, text: str, candidate: dict[str, Any]) -> list[EventDraft]:
    """The drafts every answered card starts with: the user's answer in the thread, the candidate, the card closed."""
    return [
        EventDraft(
            type="chat.message",
            channel="chat",
            chat_message={"id": new_message_id(), "role": Role.USER, "text": text, "request_id": request.id},
        ),
        EventDraft(type="field.candidate", channel="chat", candidate=candidate),
        EventDraft(
            type="input.answered",
            channel="chat",
            payload={"requestId": request.id},
            input_request_update={"id": request.id, "status": "answered"},
        ),
    ]


def _rejected(request: StoredInputRequest, field_id: str, value: Any, error: str) -> Effects:
    """An invalid answer: one more attempt; the third cancels the card (D14)."""
    attempt = request.attempts + 1
    candidate = EventDraft(
        type="field.candidate",
        channel="chat",
        candidate={"field": field_id, "source": FieldSource.CHAT, "raw": value, "status": "invalid", "error": error},
    )
    if attempt < MAX_ATTEMPTS:
        return Effects(
            events=[
                candidate,
                EventDraft(
                    type="input.rejected",
                    channel="chat",
                    payload={"requestId": request.id, "attempt": attempt, "message": error},
                    input_request_update={"id": request.id, "status": "open", "attempts": attempt},
                ),
            ],
            activity=True,
            reply={"status": "rejected"},
        )
    events = [
        candidate,
        EventDraft(
            type="input.cancelled",
            channel="chat",
            payload={"requestId": request.id, "reason": "too many attempts", "attempt": attempt},
            input_request_update={"id": request.id, "status": "cancelled", "attempts": attempt},
        ),
    ]
    if is_record_field(field_id):
        events.append(_agent_says(too_many_attempts(field_id)))
    return Effects(events=events, activity=True, reply={"status": "rejected"})


def _chat_candidate(field_id: str, value: Any, status: str, normalized: Any) -> dict[str, Any]:
    return {
        "field": field_id,
        "source": FieldSource.CHAT,
        "raw": value,
        "normalized": normalized if status == "valid" else None,
        "status": status,
    }


def open_card_ref(snapshot: Snapshot, except_id: str | None = None) -> dict[str, Any] | None:
    """The session's open card, unless it is ``except_id`` (the one being answered): ``{"id", "field", "spec"}``."""
    open_request = next((r for r in snapshot.requests if r.status == "open"), None)
    if open_request is not None and open_request.id != except_id:
        return {"id": open_request.id, "field": open_request.field, "spec": open_request.spec}
    return None


def submit_chat_input_handler(deps: FinalizeDeps) -> Handler:
    answer = _answer_card(deps)

    def handle(snapshot: Snapshot, command: SubmitChatInput) -> Effects:
        request = next((r for r in snapshot.requests if r.id == command.request_id), None)
        if snapshot.session.status == "finalized" and request is not None and request.status == "open":
            if request.field == ControlField.RESUME:
                return _resume_answer(snapshot, request, command.value)
            # The card a `partial` session kept open: answering it is the user coming back (P7-T05).
            reopened = reopened_snapshot(snapshot, "chatInput")
            if reopened is not None:
                return with_reopen(snapshot, "chatInput", answer(reopened, command))
        return answer(snapshot, command)

    return handle


def _resume_answer(snapshot: Snapshot, request: StoredInputRequest, value: Any) -> Effects:
    """ "Resume your claim?" after an opt-out: Yes reopens (and the planner carries on); No leaves the session as it is."""
    answer = validate_submit_confirmation(value)
    if answer.status != "valid":
        return _rejected(
            request,
            request.field,
            value,
            answer.error if answer.status == "invalid" and answer.error else "Please tap Yes or No.",
        )
    yes = answer.normalized is True
    events = [
        *_answered_drafts(
            request, answer_text(request.spec, value), _chat_candidate(request.field, value, "valid", answer.normalized)
        ),
        _agent_says(RESUME_ACCEPTED_MESSAGE if yes else RESUME_DECLINED_MESSAGE),
    ]
    if not yes:
        return Effects(
            events=events, reply={"status": "accepted"}
        )  # still opted out: no reopen, no new revision, no activity
    reopened = reopened_snapshot(snapshot, "resumeConfirmed")
    if reopened is None:
        return Effects(events=events, reply={"status": "accepted"})
    return with_reopen(snapshot, "resumeConfirmed", Effects(events=events, activity=True, reply={"status": "accepted"}))


def _answer_card(deps: FinalizeDeps) -> Handler:
    def handle(snapshot: Snapshot, command: SubmitChatInput) -> Effects:
        def stale(message: str) -> Effects:
            open_ref = open_card_ref(snapshot, command.request_id)
            reply: dict[str, Any] = {"status": "stale", "message": message}
            if open_ref is not None:
                reply["open"] = open_ref
            return Effects(reply=reply)

        request = next((r for r in snapshot.requests if r.id == command.request_id), None)
        if request is None:
            return stale(STALE_REQUEST_MESSAGE)
        # A repeat of an answered card: the same result, nothing new (protocol.md section 3.4).
        if request.status == "answered":
            return Effects(reply={"status": "accepted"})
        if snapshot.session.status != "active":
            return stale(CLOSED_SESSION_MESSAGE)
        if request.status != "open":
            return stale(STALE_REQUEST_MESSAGE)
        if command.field != request.field:
            return stale(WRONG_FIELD_MESSAGE)

        spec = request.spec
        value = command.value

        if is_record_field(request.field):
            field_id = request.field
            checked = _check_field_answer(snapshot, request, field_id, value)
            result = checked.result
            if result.status == "invalid":
                return _rejected(request, field_id, value, result.error or "")
            # A null answer is a skip, but only an optional card offers Skip.
            if result.status == "skipped" and FIELDS[field_id].required:
                return _rejected(request, field_id, value, "Please answer this one; it can't be skipped.")
            normalized = result.normalized if result.status == "valid" else None
            return Effects(
                events=[
                    *_answered_drafts(
                        request,
                        answer_text(spec, value, checked.file_names),
                        _chat_candidate(field_id, value, result.status, normalized),
                    ),
                    _agent_says(acknowledgement(field_id, normalized, result.status == "skipped")),
                ],
                activity=True,
                reply={"status": "accepted"},
            )

        if request.field in (ControlField.SUBMIT, ControlField.OPT_OUT):
            answer = validate_submit_confirmation(value)
            if answer.status != "valid":
                return _rejected(
                    request,
                    request.field,
                    value,
                    answer.error if answer.status == "invalid" and answer.error else "Please tap Yes or No.",
                )
            drafts = _answered_drafts(
                request, answer_text(spec, value), _chat_candidate(request.field, value, "valid", answer.normalized)
            )
            opt_out = request.field == ControlField.OPT_OUT
            if opt_out:
                drafts.append(
                    EventDraft(type="optout.confirmed" if answer.normalized else "optout.declined", channel="chat")
                )
            if not answer.normalized:
                # No to "Submit claim?": what to change. No to "Stop?": the planner brings back the paused card.
                if opt_out:
                    return Effects(
                        events=[*drafts, _agent_says(RESUME_MESSAGE)], activity=True, reply={"status": "accepted"}
                    )
                return Effects(
                    events=[
                        *drafts,
                        *open_card_drafts(
                            next_request_id(snapshot, ControlField.EDIT),
                            ControlField.EDIT,
                            edit_card(resolve_fields(snapshot.candidates)),
                            None,
                        ),
                    ],
                    activity=True,
                    reply={"status": "accepted"},
                )
            result_f = finalize_effects(
                snapshot,
                FinalizeOptions(
                    trigger="optOutConfirmed" if opt_out else "confirmSubmit",
                    submit_confirmed_at=None if opt_out else snapshot.now,
                    pending_chat_messages=1,
                    pending_chat_answers=1,
                    handled=frozenset([request.id]),
                ),
                deps,
            )
            if not result_f.finalized or result_f.effects is None:
                # Not finalizable (a required field is no longer valid): say so; the planner asks for what's missing.
                return Effects(
                    events=[*drafts, _agent_says(STILL_MISSING_MESSAGE)], activity=True, reply={"status": "accepted"}
                )
            e = result_f.effects
            finalized: dict[str, Any] = {"revision": result_f.revision, "outcome": result_f.outcome}
            if result_f.schema_problems:
                finalized["schemaProblems"] = result_f.schema_problems
            return Effects(
                events=[*drafts, *e.events],
                session=e.session,
                record=e.record,
                timers=e.timers,
                activity=True,
                reply={"status": "accepted", "finalized": finalized},
            )

        if request.field == ControlField.EDIT:
            option = _chosen(spec, value)
            if not option or not is_record_field(option):
                return _rejected(request, request.field, value, "Please choose one of the options.")
            events = _answered_drafts(
                request, answer_text(spec, value), _chat_candidate(request.field, value, "valid", option)
            )
            # One card per field: a card still queued for it (the call agent's) gives way to the re-ask.
            for other in snapshot.requests:
                if other.field == option and other.status == "queued":
                    events.append(cancel_draft(other.id, "replaced"))
            events.extend(
                open_card_drafts(next_request_id(snapshot, option), option, FIELDS[option].card, edit_lead_in(option))
            )
            return Effects(events=events, activity=True, reply={"status": "accepted"})

        # A control card this server doesn't handle (conflictChoice, P5), or "Resume your claim?" on an active session.
        return stale(STALE_REQUEST_MESSAGE)

    return handle


async def submit_chat_input_prepare(tx: Tx, snapshot: Snapshot, command: SubmitChatInput) -> SnapshotExtras:
    """Reads the answer needs beyond the snapshot: this session's uploads for a file card, and the session's cost when a
    Yes on a confirm card will finalize."""
    request = next((r for r in snapshot.requests if r.id == command.request_id), None)
    # A finalized session is read too: a partial one reopens and may finalize again in this command (P7-T05).
    if request is None or request.status != "open" or snapshot.session.status == "closed":
        return {}
    if request.field in _FILE_FIELDS:
        return {"files": await list_files(tx, snapshot.session.id)}
    if request.field in (ControlField.SUBMIT, ControlField.OPT_OUT) and command.value is True:
        return await finalize_extras(tx, snapshot.session.id)
    return {}

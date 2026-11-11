"""Every sentence the chat side writes (P4-T04).

The planner's lead-ins, acknowledgements, the summary, the control cards and the closing messages. One file, so the tone
stays consistent and is easy to tune. Pure; every string is short plain text well under the 2,000-character limit for an
outbound message (protocol.md section 7).
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from app.domain.conflicts import ResolvedField
from app.domain.fields import FIELDS, RECORD_FIELD_IDS, CardSpec, InputOptionSpec
from app.domain.validators.strings import clean_text, truncate
from app.protocol.enums import InputKind, Outcome

# ``CardSpec`` (from app.domain.fields) is a card as stored in ``input_requests.spec``: the wire ``inputRequest`` without
# its per-request parts; ``spec.to_dict()`` is its stored form.


class ControlField:
    """The control fields of protocol.md section 5 that P4 uses."""

    SUBMIT = "submitConfirmation"
    EDIT = "editField"
    OPT_OUT = "optOutConfirmation"
    RESUME = "resumeConfirmation"


def _capitalize(text: str) -> str:
    return text[:1].upper() + text[1:]


def field_name(field: str) -> str:
    return _capitalize(FIELDS[field].label)


def _js_string(value: Any) -> str:
    """``String(value)`` as JavaScript would print it, for the JSON-ish values the validators produce."""
    if value is None:
        return "undefined"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _get(value: Any, key: str) -> Any:
    return value.get(key) if isinstance(value, dict) else None


# ---------------------------------------------------------------------------------------------------------------------
# Control cards (protocol.md section 5)


def submit_card() -> CardSpec:
    return FIELDS["submitConfirmation"].card


def editable_fields(fields: Mapping[str, ResolvedField]) -> list[str]:
    """ "What would you like to change?": the record fields a typed answer can change.

    A narrative field the call collected (problem, start date, urgency) is left out: the spoken account wins over a typed
    one (D15), so editing it in chat couldn't change the record (P4 review #2; changing that policy is an owner decision).
    """
    return [i for i in RECORD_FIELD_IDS if not (FIELDS[i].conflict_class == "narrative" and fields[i].source == "call")]


def edit_card(fields: Mapping[str, ResolvedField]) -> CardSpec:
    return CardSpec(
        kind=InputKind.SELECT,
        label="What would you like to change?",
        required=True,
        options=tuple(InputOptionSpec(value=i, label=field_name(i)) for i in editable_fields(fields)),
    )


def opt_out_card() -> CardSpec:
    return CardSpec(
        kind=InputKind.CONFIRM, label="Stop your claim?", help="What you've shared so far will be kept.", required=True
    )


def resume_card() -> CardSpec:
    """ "Resume your claim?": what a user who opted out sees when they come back (P7-T05, protocol.md section 5)."""
    return CardSpec(
        kind=InputKind.CONFIRM, label="Resume your claim?", help="What you shared before is still saved.", required=True
    )


RESUME_PROMPT = "Welcome back. You stopped this claim earlier. Would you like to pick it up again?"
RESUME_ACCEPTED_MESSAGE = "Welcome back. Let's carry on."
RESUME_DECLINED_MESSAGE = "OK, your claim stays stopped."

# ---------------------------------------------------------------------------------------------------------------------
# Lead-ins: one short message with each new card the planner opens (P4-T01 step 4)

LEAD_INS: dict[str, str] = {
    "deviceType": "Let's start with your device.",
    "deviceModel": "Which model is it exactly?",
    "problemDescription": "Now tell me what's going wrong with it.",
    "problemStartedAt": "When did you first notice the problem?",
    "urgency": "How soon do you need it back?",
    "serialNumber": "Next, the device's serial number or IMEI, so we can look up its warranty.",
    "purchaseInvoice": "Please upload your purchase invoice.",
    "serviceCentre": "Pick the service centre that suits you best.",
    "email": "Where should we send updates about your claim?",
    "additionalPhotos": "If you have photos of the device or the damage, you can add them here. This is optional.",
    "additionalNotes": "Anything else the technician should know? This is optional too.",
}


def lead_in(field: str, *, after_call: bool, in_call: bool) -> str:
    """``after_call``: the first card the planner opens since the call ended (the hand-off to chat, architecture 5.3).

    ``in_call``: opened by the 60 s safety net during a call (P4-T01).
    """
    if in_call:
        return f"While we talk, you can fill this in here: {FIELDS[field].card.label}"
    text = LEAD_INS[field]
    return f"Thanks for the call. Let's finish the rest here in chat. {text}" if after_call else text


def agent_card_lead_in(field: str) -> str:
    """The planner opened a card the call agent asked for (P5's request_chat_input)."""
    return f"I've sent you a box for your {FIELDS[field].label}."


RESUME_MESSAGE = "OK, let's carry on."
CHAT_START_MESSAGE = "No problem if you'd rather not call. We can do everything here in chat."


def edit_lead_in(field: str) -> str:
    return f"Sure. What's the correct {FIELDS[field].label}?"


STILL_MISSING_MESSAGE = "Something still needs your answer before the claim can be submitted."

# ---------------------------------------------------------------------------------------------------------------------
# Answers


def _spec_kind(spec: Any) -> Any:
    return spec.get("kind") if isinstance(spec, dict) else spec.kind


def _spec_options(spec: Any) -> list[tuple[Any, Any]]:
    options = spec.get("options") if isinstance(spec, dict) else spec.options
    if not options:
        return []
    return [(o.get("value"), o.get("label")) if isinstance(o, dict) else (o.value, o.label) for o in options]


def answer_text(spec: CardSpec | Mapping[str, Any], value: Any, file_names: Sequence[str] = ()) -> str:
    """The user's answer as one line of the thread (a replayed answer bubble, protocol.md section 3.3 ``message`` role user).

    ``spec`` is a ``CardSpec`` or the stored dict of one.
    """
    if value is None or (isinstance(value, list) and len(value) == 0):
        return "(skipped)"
    kind = _spec_kind(spec)
    if kind == InputKind.CONFIRM:
        return "Yes" if value is True else "No"
    if kind == InputKind.FILE:
        if len(file_names) > 0:
            return truncate(", ".join(file_names), 500)
        count = len(value) if isinstance(value, list) else 1
        return "1 file" if count == 1 else f"{count} files"
    values = value if isinstance(value, list) else [value]
    options = _spec_options(spec)

    def label(item: Any) -> str:
        for option_value, option_label in options:
            if option_value == item and option_label is not None:
                return str(option_label)
        return _js_string(item)

    return truncate(clean_text(", ".join(label(item) for item in values), multiline=True), 1000) or "(empty)"


def acknowledgement(field: str, normalized: Any, skipped: bool) -> str:
    """ "Thanks, ...": the acknowledgement of a valid answer, built from the normalized value (only validated facts)."""
    if skipped:
        return "No problem, we'll skip that."
    if field == "serialNumber":
        return (
            "Thanks, I've got your IMEI."
            if _get(normalized, "kind") == "imei"
            else "Thanks, I've got your serial number."
        )
    if field == "purchaseInvoice":
        return "Thanks, your invoice is uploaded."
    if field == "serviceCentre":
        name = _get(normalized, "name")
        return f"Great, {_js_string(name) if name is not None else 'that centre'} it is."
    if field == "email":
        return f"Thanks, updates will go to {_js_string(normalized)}."
    if field == "additionalPhotos":
        return (
            "Thanks, I've added your photo."
            if isinstance(normalized, list) and len(normalized) == 1
            else "Thanks, I've added your photos."
        )
    if field == "additionalNotes":
        return "Thanks, I've added your note for the technician."
    if field == "deviceModel":
        name = " ".join(p for p in (_get(normalized, "brand"), _get(normalized, "model")) if isinstance(p, str))
        return f"Got it, {name}." if name else "No problem, we'll note that you're not sure of the model."
    return "Got it, thanks."


def too_many_attempts(field: str) -> str:
    """The third invalid answer (D14): the card is cancelled and the field is left for the team."""
    return (
        f"That {FIELDS[field].label} still doesn't look right, so I'll leave it for our team to check. Let's carry on."
    )


#: Nothing more can be asked, but a required field couldn't be accepted, so the claim can't be confirmed (D16).
STALLED_MESSAGE = "That's everything I can collect here. Some details couldn't be confirmed, so our team will review your claim and get in touch."

# ---------------------------------------------------------------------------------------------------------------------
# Summary and outcome

_KB = 1024


def _size(value: Any) -> str:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return ""
    if value < _KB * _KB:
        return f"{max(1, math.floor(value / _KB + 0.5))} KB"
    megabytes = Decimal(value / (_KB * _KB)).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)
    return f"{megabytes} MB"


_FILE_KIND = {"application/pdf": "PDF", "image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WebP"}

#: 11 lines of at most this much stay well under the 2,000-character message limit (protocol.md section 7).
SUMMARY_VALUE_CHARS = 140


def _option_label(field: str, value: Any) -> str:
    for option in FIELDS[field].card.options or ():
        if option.value == value and option.label is not None:
            return option.label
    return _js_string(value)


def summary_value(field: str, resolved: ResolvedField) -> str:
    """One field's value as the summary shows it (capped, so the whole summary stays short)."""
    if resolved.status in ("skipped", "missing"):
        return "missing" if FIELDS[field].required else "none"
    if resolved.status != "valid":
        return f"not accepted ({resolved.status})"
    v = resolved.value
    if field == "deviceType":
        text = _option_label(field, v)
    elif field == "deviceModel":
        text = " ".join(p for p in (_get(v, "brand"), _get(v, "model")) if isinstance(p, str)) or "not known"
    elif field == "problemDescription":
        summary = _get(v, "summary")
        text = _js_string(summary) if summary is not None else ""
    elif field == "problemStartedAt":
        precision = _get(v, "precision")
        suffix = "" if precision == "day" else f" (around then, by {_js_string(precision)})"
        text = f"{_js_string(_get(v, 'date'))}{suffix}"
    elif field == "urgency":
        text = _option_label(field, _get(v, "level"))
    elif field == "serialNumber":
        text = f"{'IMEI' if _get(v, 'kind') == 'imei' else 'Serial'} {_js_string(_get(v, 'value'))}"
    elif field == "purchaseInvoice":
        text = f"{_FILE_KIND.get(_js_string(_get(v, 'mime')), 'file')}, {_size(_get(v, 'size'))}"
    elif field == "serviceCentre":
        text = f"{_js_string(_get(v, 'name'))}, {_js_string(_get(v, 'city'))}"
    elif field == "additionalPhotos":
        text = ("1 photo" if len(v) == 1 else f"{len(v)} photos") if isinstance(v, list) else "none"
    else:
        text = _js_string(v)
    return truncate(clean_text(text), SUMMARY_VALUE_CHARS)


def summary_message(fields: Mapping[str, ResolvedField]) -> str:
    lines = [f"• {field_name(i)}: {summary_value(i, fields[i])}" for i in RECORD_FIELD_IDS]
    return "\n".join(["Here's your claim:", *lines])


def finalized_message(outcome: Outcome | str) -> str:
    value = outcome.value if isinstance(outcome, Outcome) else outcome
    if value == Outcome.COMPLETED.value:
        return "Thanks, your claim is submitted. We'll email you with updates."
    if value == Outcome.NEEDS_REVIEW.value:
        return "Thanks, your claim is submitted. A member of our team will review it and get in touch."
    if value == Outcome.OPTED_OUT.value:
        return "OK, I've stopped your claim. What you shared so far has been kept."
    return "We've saved your claim as it is. You can come back to this page to finish it."


#: Why outstanding cards are closed when the session is finalized (inputCancel reason).
FINALIZED_CANCEL_REASON = "the claim is closed"

# ---------------------------------------------------------------------------------------------------------------------
# Call endings (P5-T09): the chat says why a call ended when the user didn't end it themselves. After a hang-up or
# the agent's goodbye, the planner's first card carries "Thanks for the call..." instead.

_CALL_ENDED: dict[str, str | None] = {
    "hangup": None,
    "agent_ended": None,
    "opted_out": None,
    "network": "The call dropped. Let's continue here in chat.",
    "silence": "I didn't hear anything for a while, so I ended the call. Let's continue here in chat.",
    "max_duration": "We reached the time limit for a call. Let's finish here in chat.",
    "provider_error": "I'm having trouble with the voice line, so let's continue here in chat.",
    "server_restart": "The call was interrupted; let's continue here.",
}


def call_ended_message(reason: str) -> str | None:
    return _CALL_ENDED.get(reason)

"""What the call agent says from templates rather than the model (D13).

Acknowledgements built only from validated tool results, silence reprompts, and closing lines. Short, spoken English
(P5-T05 style rules).
"""

from __future__ import annotations

from typing import Any

from app.domain.fields import FIELDS


def _get(value: Any, key: str) -> Any:
    return value.get(key) if isinstance(value, dict) else None


def saved_ack(field: str, normalized: Any) -> str:
    """A validated spoken value, acknowledged (acknowledge-then-ask). Never echoes identifiers."""
    if field == "deviceModel":
        name = " ".join(p for p in (_get(normalized, "brand"), _get(normalized, "model")) if isinstance(p, str))
        return f"Got it, {name}." if name else "No problem."
    if field == "problemDescription":
        return "I'm sorry to hear that."
    if field == "urgency":
        return "Understood."
    if field == "serviceCentre":
        name = _get(normalized, "name")
        return f"Got it, {name}." if isinstance(name, str) else "Got it."
    return "Got it."


def card_sent_ack(field: str) -> str:
    if field == "submitConfirmation":
        return "I've put a summary in the chat. Please check it and tap Yes to submit."
    label = FIELDS[field].label if field in FIELDS else "details"
    return f"I've sent a box to your chat for the {label}."


def type_it_ack(field: str) -> str:
    return f"Thanks. Please type your {FIELDS[field].label} in the chat box I've sent, so I get it exactly right."


OPTED_OUT_GOODBYE = "OK, I've stopped your claim. What you've shared so far is kept. Goodbye."
SUBMITTED_GOODBYE = "Your claim is submitted. Thank you, goodbye."
REPROMPTS = [
    "Are you still there? Take your time.",
    "If now isn't a good time, we can finish in the chat. Are you there?",
]
PROVIDER_TROUBLE = "I'm having trouble hearing you, so let's continue in the chat."

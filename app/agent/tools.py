"""The call agent's tools (P5-T05, D13).

JSON-schema definitions (OpenAI-compatible, deterministic order, sent with the frozen system prompt) and strict
validators. Arguments are validated server-side before anything runs (provider-side ``strict`` mode isn't relied on);
an invalid call gets an error result, never an effect.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from app.domain.fields import CHAT_FIELDS, FIELDS, OPTIONAL_FIELDS, RECORD_FIELD_IDS
from app.voice.types import ToolDefinition

#: Fields the agent may save from speech (catalog ``spoken_capture``): the call fields plus identifiers heard aloud.
SPOKEN_FIELDS: list[str] = [field_id for field_id in RECORD_FIELD_IDS if FIELDS[field_id].spoken_capture]
#: Cards the agent may send: the chat fields, the optional ones and the submit confirmation.
CARD_FIELDS: list[str] = [*CHAT_FIELDS, *OPTIONAL_FIELDS, "submitConfirmation"]

TOOL_NAMES = ("save_field", "request_chat_input", "flag_for_review", "opt_out", "end_call")


def is_tool_name(name: str) -> bool:
    return name in TOOL_NAMES


TOOLS: tuple[ToolDefinition, ...] = (
    ToolDefinition(
        name="save_field",
        description="Save a value the customer said on the call. Call it once per field you learned this turn. For serialNumber and email it only notes what you heard: they must still type it in the chat card.",
        parameters={
            "type": "object",
            "properties": {
                "field": {"type": "string", "enum": SPOKEN_FIELDS},
                "value": {
                    "type": "string",
                    "description": "Your normalized value, e.g. 'Apple iPhone 14 Pro', 'high'. For dates pass the customer's words, e.g. 'last Tuesday'.",
                },
                "spoken_evidence": {"type": "string", "description": "The customer's exact words."},
                "user_confirmed": {
                    "type": "boolean",
                    "description": "True only if the customer confirmed this value when you read it back.",
                },
            },
            "required": ["field", "value", "spoken_evidence"],
            "additionalProperties": False,
        },
    ),
    ToolDefinition(
        name="request_chat_input",
        description="Send an input card to the customer's chat. Use it for fields that are awkward to say, and for submitConfirmation when everything required is collected.",
        parameters={
            "type": "object",
            "properties": {"field": {"type": "string", "enum": list(CARD_FIELDS)}},
            "required": ["field"],
            "additionalProperties": False,
        },
    ),
    ToolDefinition(
        name="flag_for_review",
        description="Flag the claim for a human: kind 'safety' for a swollen battery, smoke, burning, sparks or liquid while charging; 'other' for anything you shouldn't decide.",
        parameters={
            "type": "object",
            "properties": {"kind": {"type": "string", "enum": ["safety", "other"]}, "reason": {"type": "string"}},
            "required": ["kind", "reason"],
            "additionalProperties": False,
        },
    ),
    ToolDefinition(
        name="opt_out",
        description="The customer wants to stop the claim. Ask them to confirm first; call with confirmed true only after they said yes.",
        parameters={
            "type": "object",
            "properties": {"confirmed": {"type": "boolean"}},
            "required": ["confirmed"],
            "additionalProperties": False,
        },
    ),
    ToolDefinition(
        name="end_call",
        description="End the call, after you have said goodbye.",
        parameters={"type": "object", "properties": {"reason": {"type": "string"}}, "additionalProperties": False},
    ),
)


def tools_json() -> str:
    """``JSON.stringify(TOOLS)``: compact, insertion-ordered, non-ASCII kept (feeds the prompt prefix hash)."""
    return json.dumps(
        [{"name": t.name, "description": t.description, "parameters": t.parameters} for t in TOOLS],
        separators=(",", ":"),
        ensure_ascii=False,
    )


@dataclass(frozen=True, slots=True)
class ParsedToolCall:
    """A validated call: ``name`` is one of TOOL_NAMES, ``args`` the checked arguments (schema keys, snake_case)."""

    name: str
    args: dict[str, Any]


@dataclass(frozen=True, slots=True)
class ToolParseResult:
    ok: bool
    call: ParsedToolCall | None = None
    error: str | None = None


# --- validation (zod's strictObject, by hand) -----------------------------------------------------------------------

_Issues = list[str]


def _is_string(value: Any) -> bool:
    return isinstance(value, str)


def _check(name: str, obj: dict[str, Any], rules: dict[str, tuple[bool, Any]]) -> _Issues:
    """``rules``: key -> (required, validator returning an error message or None)."""
    issues: _Issues = []
    for key in obj:
        if key not in rules:
            issues.append(f"(root) Unrecognized key(s) in object: '{key}'")
    for key, (required, validator) in rules.items():
        if key not in obj:
            if required:
                issues.append(f"{key} Required")
            continue
        message = validator(obj[key])
        if message:
            issues.append(f"{key} {message}")
    return issues


def _enum(options: list[str]) -> Any:
    def validate(value: Any) -> str | None:
        if value in options and isinstance(value, str):
            return None
        return "Invalid enum value. Expected " + " | ".join(f"'{o}'" for o in options) + f", received '{value}'"

    return validate


def _string(min_len: int = 0, max_len: int | None = None, no_angle: bool = False) -> Any:
    def validate(value: Any) -> str | None:
        if not isinstance(value, str):
            return "Expected string"
        if len(value) < min_len:
            return f"String must contain at least {min_len} character(s)"
        if max_len is not None and len(value) > max_len:
            return f"String must contain at most {max_len} character(s)"
        if no_angle and ("<" in value or ">" in value):
            return "value must be plain words, no tags or markup"
        return None

    return validate


def _boolean(value: Any) -> str | None:
    return None if isinstance(value, bool) else "Expected boolean"


_RULES: dict[str, dict[str, tuple[bool, Any]]] = {
    "save_field": {
        "field": (True, _enum(SPOKEN_FIELDS)),
        "value": (True, _string(1, 1000, no_angle=True)),
        "spoken_evidence": (True, _string(0, 1000)),
        "user_confirmed": (False, _boolean),
    },
    "request_chat_input": {"field": (True, _enum(CARD_FIELDS))},
    "flag_for_review": {"kind": (True, _enum(["safety", "other"])), "reason": (True, _string(1, 300))},
    "opt_out": {"confirmed": (True, _boolean)},
    "end_call": {"reason": (False, _string(0, 200))},
}


def parse_tool_call(name: str, raw_arguments: str) -> ToolParseResult:
    """Validates one call's name and JSON arguments; the error is what the model is told."""
    if not is_tool_name(name):
        return ToolParseResult(ok=False, error=f'unknown tool "{name[:40]}"')
    try:
        data = json.loads(raw_arguments or "{}")
    except ValueError:
        return ToolParseResult(ok=False, error="arguments are not valid JSON")
    if not isinstance(data, dict):
        return ToolParseResult(ok=False, error="invalid arguments: (root) Expected object")
    issues = _check(name, data, _RULES[name])
    if issues:
        return ToolParseResult(ok=False, error=f"invalid arguments: {'; '.join(issues)}")
    return ToolParseResult(ok=True, call=ParsedToolCall(name=name, args=data))

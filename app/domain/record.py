"""The final record (architecture section 7, D17, P2-T07): the sanitized, structured output the business receives.
Pure apart from SHA-256: everything it needs (resolved fields, the outcome decision, engagement, cost, a file-URL
signer) is passed in. The record itself is a plain JSON dict (camelCase keys, exactly the delivered payload); the
sanitization pipeline below is applied in this order on every build."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, NamedTuple

from jsonschema import Draft202012Validator

from app.protocol.enums import Outcome

from .canonical_json import canonical_json
from .conflicts import ResolvedField
from .dates import to_ist_iso
from .fields import RECORD_FIELD_IDS
from .outcome import ReviewFlag
from .validators.strings import clean_text, truncate

RECORD_SCHEMA_VERSION = "1.0"

# shared/record.schema.json at the repository root (the same file the TS server and the docs use).
RECORD_SCHEMA_PATH = Path(__file__).resolve().parents[2] / "shared" / "record.schema.json"

# The record as delivered: a JSON-ready dict with the keys documented in shared/record.schema.json.
ClaimRecord = dict[str, Any]


@dataclass(frozen=True, slots=True)
class Engagement:
    calls: int
    call_seconds: int
    chat_messages: int
    chat_inputs_submitted: int
    invalid_attempts: int

    def to_dict(self) -> dict[str, int]:
        return {
            "calls": self.calls,
            "callSeconds": self.call_seconds,
            "chatMessages": self.chat_messages,
            "chatInputsSubmitted": self.chat_inputs_submitted,
            "invalidAttempts": self.invalid_attempts,
        }


@dataclass(frozen=True, slots=True)
class CostBreakdown:
    stt: float
    llm: float
    tts: float
    vision: float


@dataclass(frozen=True, slots=True)
class RecordCost:
    cost_usd: float
    cost_breakdown_usd: CostBreakdown
    actual_spend_usd: float


@dataclass(frozen=True, slots=True)
class PreviousRevision:
    revision: int
    outcome: Outcome | str


@dataclass(frozen=True, slots=True)
class RecordInput:
    session_id: str
    revision: int
    previous_revision: PreviousRevision | None
    # From decide_outcome (a finalizing decision).
    outcome: Outcome | str
    outcome_reason: str
    review_flags: Sequence[ReviewFlag]
    missing_required: Sequence[str]
    # Resolved fields (conflicts.py), one per record field.
    fields: Mapping[str, ResolvedField]
    # When the user tapped Yes on "Submit claim?", if they did since the session was last opened (ISO 8601).
    submit_confirmed_at: str | None
    engagement: Engagement
    cost: RecordCost
    # When the session reached its end state (e.g. the idle timer's due time).
    ended_at: datetime
    now: datetime
    # Signed, expiring download URL for a stored file (D10).
    sign_file_url: Callable[[str], str]


class BuiltRecord(NamedTuple):
    record: ClaimRecord
    content_hash: str


@dataclass(frozen=True, slots=True)
class RecordProblem:
    path: str
    keyword: str
    message: str


class RecordSchemaError(Exception):
    """The record broke its schema. `problems` carry JSON pointers and keywords only; never the values."""

    def __init__(self, problems: Sequence[RecordProblem]) -> None:
        super().__init__(f"record failed its schema: {'; '.join(f'{p.path} {p.message}' for p in problems)}")
        self.name = "RecordSchemaError"
        self.problems = list(problems)


_schema = json.loads(RECORD_SCHEMA_PATH.read_text(encoding="utf-8"))
Draft202012Validator.check_schema(_schema)
_validator = Draft202012Validator(_schema)


# ---------------------------------------------------------------------------------------------------------------------
# Steps 1, 2 and 4: string hygiene, per-field shape, internal fields stripped. Each value is rebuilt from the keys the
# schema allows, so evidence strings, raw input or file paths a candidate might carry can never reach the record.


def _text(value: Any, max_chars: int, *, multiline: bool = False) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = truncate(clean_text(value, multiline=multiline), max_chars)
    return None if cleaned == "" else cleaned


def _get(value: Any, key: str) -> Any:
    return value.get(key) if isinstance(value, dict) else None


def _file_value(value: Any, sign: Callable[[str], str]) -> dict[str, Any] | None:
    file_id = _get(value, "fileId")
    if not isinstance(file_id, str):
        return None
    return {
        "fileId": file_id,
        "mime": _get(value, "mime"),
        "size": _get(value, "size"),
        "sha256": _get(value, "sha256"),
        "url": sign(file_id),
    }


def project_value(field: str, value: Any, sign: Callable[[str], str]) -> Any:
    """Projects a resolved value onto exactly the shape the schema allows for that field."""
    if value is None:
        return None
    match field:
        case "deviceType" | "email":
            return _text(value, 254)
        case "additionalNotes":
            return _text(value, 1000, multiline=True)  # notes keep their line breaks
        case "deviceModel":
            return {"brand": _text(_get(value, "brand"), 80), "model": _text(_get(value, "model"), 80)}
        case "problemDescription":
            return {
                "summary": _text(_get(value, "summary"), 300),
                "verbatim": _text(_get(value, "verbatim"), 1000),
            }
        case "problemStartedAt":
            return {
                "date": _get(value, "date"),
                "precision": _get(value, "precision"),
                "spoken": _text(_get(value, "spoken"), 200),
            }
        case "urgency":
            return {"level": _get(value, "level"), "reason": _text(_get(value, "reason"), 200)}
        case "serialNumber":
            return {"kind": _get(value, "kind"), "value": _get(value, "value")}
        case "serviceCentre":
            return {
                "id": _get(value, "id"),
                "name": _text(_get(value, "name"), 100),
                "city": _text(_get(value, "city"), 60),
            }
        case "purchaseInvoice":
            return _file_value(value, sign)
        case "additionalPhotos":
            return [_file_value(item, sign) for item in value] if isinstance(value, list | tuple) else None
    return None


# Used when a stored flag's reason is empty after cleaning, so every flag still says why.
_RULE_DESCRIPTIONS = {
    "R-1": "safety hazard reported",
    "R-2": "identifier conflict unresolved",
    "R-3": "required field invalid after 3 attempts",
    "R-4": "uploaded file flagged by the vision check",
    "R-5": "flagged for review by the agent",
}


def _timestamp(iso: str | None) -> str | None:
    return None if iso is None else to_ist_iso(iso)


def without_file_urls(value: Any) -> Any:
    """Same value with file URLs removed: signed URLs change on every build and must not create a revision."""
    if isinstance(value, list | tuple):
        return [without_file_urls(item) for item in value]
    if isinstance(value, Mapping):
        return {key: without_file_urls(item) for key, item in value.items() if key != "url"}
    return value


def content_hash(record: ClaimRecord) -> str:
    """SHA-256 of the canonical JSON of the parts that define the claim (D17): outcome, outcomeReason, fields,
    missingRequired, conflicts, reviewFlags, submitConfirmation. Engagement, cost and timestamps of the build itself
    are excluded, so they alone never create a new revision; so are signed file URLs."""
    scope = {
        "outcome": record["outcome"],
        "outcomeReason": record["outcomeReason"],
        "fields": without_file_urls(record["fields"]),
        "missingRequired": record["missingRequired"],
        "conflicts": record["conflicts"],
        "reviewFlags": record["reviewFlags"],
        "submitConfirmation": record["submitConfirmation"],
    }
    return hashlib.sha256(canonical_json(scope).encode("utf-8")).hexdigest()


def _pointer(path: Sequence[Any]) -> str:
    return "/" + "/".join(str(p) for p in path)


def validate_record(record: Any) -> None:
    """Raises RecordSchemaError (paths and keywords only, never values) when the record breaks its schema."""
    errors = sorted(_validator.iter_errors(record), key=lambda e: [str(p) for p in e.absolute_path])
    if errors:
        raise RecordSchemaError(
            [
                # The library's messages quote the offending value; ours name only the keyword.
                RecordProblem(path=_pointer(e.absolute_path), keyword=str(e.validator), message=f"fails {e.validator}")
                for e in errors
            ]
        )


def build_record(input: RecordInput) -> BuiltRecord:
    """Builds, validates (step 7) and hashes (step 8) the record. Raises RecordSchemaError if the result is invalid."""
    fields: dict[str, Any] = {}
    conflicts: list[dict[str, Any]] = []
    sign = input.sign_file_url
    # Step 6: keys are written in a fixed order (catalog order for fields; the order below for the record).
    for field_id in RECORD_FIELD_IDS:
        resolved = input.fields[field_id]
        fields[field_id] = {
            "value": project_value(field_id, resolved.value, sign),  # step 5: files become signed descriptors
            "source": resolved.source,
            "collectedAt": _timestamp(resolved.collected_at),
            "status": resolved.status,
        }
        conflict = resolved.conflict
        if conflict is not None:
            conflicts.append(
                {
                    "field": field_id,
                    "callValue": without_file_urls(project_value(field_id, conflict.call_value, sign)),
                    "chatValue": without_file_urls(project_value(field_id, conflict.chat_value, sign)),
                    "resolution": conflict.resolution,
                    "reason": truncate(clean_text(conflict.reason), 300),
                }
            )

    previous = input.previous_revision
    breakdown = input.cost.cost_breakdown_usd
    record: ClaimRecord = {
        "schemaVersion": RECORD_SCHEMA_VERSION,
        "sessionId": input.session_id,
        "revision": input.revision,
        "outcome": str(input.outcome),
        "outcomeReason": truncate(clean_text(input.outcome_reason), 1000),
        "previousRevision": (
            {"revision": previous.revision, "outcome": str(previous.outcome)} if previous is not None else None
        ),
        "fields": fields,
        "missingRequired": list(input.missing_required),
        "conflicts": conflicts,
        "reviewFlags": [
            {
                "rule": flag.rule,
                "reason": truncate(clean_text(flag.reason), 300) or _RULE_DESCRIPTIONS[flag.rule],
            }
            for flag in input.review_flags
        ],
        "submitConfirmation": (
            {"confirmed": True, "source": "chat", "at": to_ist_iso(input.submit_confirmed_at)}
            if input.submit_confirmed_at
            else None
        ),
        "engagement": input.engagement.to_dict(),
        "costUsd": input.cost.cost_usd,
        "costBreakdownUsd": {
            "stt": breakdown.stt,
            "llm": breakdown.llm,
            "tts": breakdown.tts,
            "vision": breakdown.vision,
        },
        "actualSpendUsd": input.cost.actual_spend_usd,
        "createdAt": to_ist_iso(input.now),
        "endedAt": to_ist_iso(input.ended_at),
    }
    validate_record(record)
    return BuiltRecord(record, content_hash(record))

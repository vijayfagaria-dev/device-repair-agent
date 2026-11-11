# ruff: noqa: RUF001
"""Random record inputs for fuzz tests (P2-T07, P6-T02): random answers through the real validators, the resolver and
the outcome machine. Reproducible from a seed."""

from __future__ import annotations

import base64
import re
from datetime import UTC, datetime, timedelta
from typing import Any

from app.domain.conflicts import Candidate, resolve_field
from app.domain.fields import RECORD_FIELD_IDS
from app.domain.outcome import OutcomeFacts, ReviewFlag, decide_outcome
from app.domain.record import CostBreakdown, Engagement, RecordCost, RecordInput
from app.domain.validators.chat_fields import (
    validate_additional_notes,
    validate_email,
    validate_serial_number,
    validate_service_centre,
)
from app.domain.validators.files import validate_upload
from app.domain.validators.result import ValidationResult
from app.domain.validators.voice_fields import (
    validate_device_model,
    validate_device_type,
    validate_problem_description,
    validate_problem_started_at,
    validate_urgency,
)

from .helpers import Prng
from .scenarios import TODAY, iso_z, signer

CONTROL = ["\u0000", "\u0007", "\u001b", "\u007f", "\u0085", "​", "‮", "﻿", "\r\n", "\t"]
EXOTIC = ["é", "é", "😀", "👩🏽‍💻", "१२३", "１２３", "Ａ", '"', "'", "<script>", "@", "-", ".", "/", "\\", "ß", "İ"]
# Bait for the sanitization oracle (P6-T02): things that must never reach a record outside what the user wrote.
BAIT = ["/data/uploads/f1.pdf", "file:fAbc12345", "sk-abcdef123456", "chatcmpl-abcdef12", "req_01abcdefghij"]


def junk(random: Prng) -> str:
    length = random.pick([0, 1, 3, 12, 60, 400, 1200])
    parts: list[str] = []
    for _ in range(length):
        roll = random.next()
        if roll < 0.08:
            parts.append(random.pick(CONTROL))
        elif roll < 0.2:
            parts.append(random.pick(EXOTIC))
        elif roll < 0.23:
            parts.append(f" {random.pick(BAIT)} ")
        else:
            parts.append(chr(32 + random.int(95)))
    return "".join(parts)


SAMPLES: dict[str, list[Any]] = {
    "deviceType": ["phone", "my laptop", "galaxy watch", "a thing", "other", "AirPods", ""],
    "deviceModel": [
        "iPhone 14 Pro",
        "Samsung",
        "I don't know",
        "Zorbo X1",
        {"brand": "Dell", "model": "XPS 13"},
        "x" * 90,
    ],
    "problemDescription": [
        "the screen flickers and goes black",
        "it's broken",
        {"summary": "S", "verbatim": "battery drains very fast overnight"},
    ],
    "problemStartedAt": [
        "yesterday",
        "last Tuesday",
        "two weeks ago",
        "2026-10-01",
        "tomorrow",
        "I don't know",
        {"spoken": "last month", "date": "2020-01-01"},
        "2049-01-01",
    ],
    "urgency": ["high", "no rush", "need it for work tomorrow", "hmm", {"level": "critical", "reason": "medical"}],
    "serialNumber": ["352099001761481", "35209900176148", "C02XL0GHJG5H", "AAAAAAAA", "abc#123"],
    "email": ["asha@example.com", "a@b", "user@bücher.de", "foo@@x.com", "  A@Example.COM "],
    "serviceCentre": ["blr-koramangala", "del-saket", "forged", "Koramangala"],
    "additionalNotes": ["note", None, "", "x" * 1001],
}

PDF = b"%PDF-1.4\n%%EOF\n"
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)

_B36 = "0123456789abcdefghijklmnopqrstuvwxyz"


def _base36(n: int) -> str:
    if n == 0:
        return "0"
    out = ""
    while n:
        n, r = divmod(n, 36)
        out = _B36[r] + out
    return out


def random_file(random: Prng, field: str) -> dict[str, Any] | None:
    data = random.pick([PDF, PNG]) + junk(random).encode("utf-8")
    checked = validate_upload(field, bytes=data, declared_type=random.pick([None, "image/png", "application/pdf"]))  # type: ignore[arg-type]
    if checked.status != "valid":
        return None
    stored = {k: v for k, v in checked.normalized.items() if k != "originalName"}  # type: ignore[union-attr]
    return {"fileId": f"f{_base36(random.int(10**9)).rjust(10, '0')}", **stored}


def random_answer(random: Prng, field: str, source: str) -> ValidationResult[Any]:
    raw = junk(random) if random.chance(0.35) else random.pick(SAMPLES.get(field, [None]))
    match field:
        case "deviceType":
            return validate_device_type(raw)
        case "deviceModel":
            return validate_device_model(raw, allow_unknown=random.chance(0.5))
        case "problemDescription":
            return validate_problem_description(raw)
        case "problemStartedAt":
            return validate_problem_started_at(raw, today=TODAY)
        case "urgency":
            return validate_urgency(raw)
        case "serialNumber":
            return validate_serial_number(raw)
        case "email":
            return validate_email(raw)
        case "serviceCentre":
            return validate_service_centre(raw, spoken=source == "call")
        case "additionalNotes":
            return validate_additional_notes(raw)
        case "purchaseInvoice":
            f = random_file(random, field)
            return ValidationResult("valid", normalized=f) if f else ValidationResult("invalid", error="x")
        case "additionalPhotos":
            if random.chance(0.2):
                return ValidationResult("skipped")
            files = [random_file(random, field) for _ in range(1 + random.int(5))]
            files = [f for f in files if f is not None]
            return ValidationResult("valid", normalized=files) if files else ValidationResult("invalid", error="x")
    raise AssertionError(field)


TRIGGERS = ["confirmSubmit", "optOutConfirmed", "idleTimeout", "testFinalize"]


def random_record_input(random: Prng) -> RecordInput:
    """One random, finalizable record input. A refused submit confirmation falls back to the idle timer, as in
    production."""
    seq = 0
    fields: dict[str, Any] = {}
    for field_id in RECORD_FIELD_IDS:
        history: list[Candidate] = []
        for _ in range(random.int(5)):
            source = "call" if random.chance(0.5) else "chat"
            result = random_answer(random, field_id, source)
            seq += 1 + random.int(3)
            heard = source == "call" and field_id in ("serialNumber", "email") and result.status == "valid"
            history.append(
                Candidate(
                    source=source,  # type: ignore[arg-type]
                    seq=seq,
                    collected_at=iso_z(datetime(2026, 11, 10, 4, 0, 0, tzinfo=UTC) + timedelta(seconds=seq)),
                    status="unverified" if heard else result.status,  # type: ignore[arg-type]
                    normalized=result.normalized if result.status == "valid" else None,
                    user_confirmed=random.chance(0.1),
                )
            )
        fields[field_id] = resolve_field(field_id, history)
    facts = OutcomeFacts(
        fields=fields,
        attempts={i: random.int(4) for i in RECORD_FIELD_IDS},
        submit_confirmed=random.chance(0.3),
        stored_flags=[ReviewFlag("R-1", junk(random) or "safety")] if random.chance(0.1) else [],
    )
    auto = random.chance(0.5)
    trigger = random.pick(TRIGGERS)
    decision = decide_outcome(facts, trigger, auto_complete_on_idle=auto)  # type: ignore[arg-type]
    if not decision.finalize:
        # Only a submit confirmation with a required field not valid is refused; that session ends on the idle timer.
        if trigger != "confirmSubmit" or not re.match(
            r"^cannot confirm submission: required fields not valid: ", decision.reason
        ):
            raise AssertionError(f"unexpected refusal: {decision.reason}")
        decision = decide_outcome(facts, "idleTimeout", auto_complete_on_idle=auto)
    if not decision.finalize:
        raise AssertionError("idle timeout always finalizes")
    return RecordInput(
        session_id="0b6f4c1e-3d2a-4e8b-9a71-5c2d8e9f1a3b",
        revision=1 + random.int(3),
        previous_revision=None,
        outcome=decision.outcome,  # type: ignore[arg-type]
        outcome_reason=decision.reason,
        review_flags=decision.review_flags,
        missing_required=decision.missing_required,
        fields=fields,
        submit_confirmed_at="2026-11-10T04:46:30Z" if random.chance(0.5) else None,
        engagement=Engagement(
            calls=random.int(3),
            call_seconds=random.int(600),
            chat_messages=random.int(30),
            chat_inputs_submitted=random.int(12),
            invalid_attempts=random.int(6),
        ),
        cost=RecordCost(
            cost_usd=random.next(),
            cost_breakdown_usd=CostBreakdown(stt=random.next(), llm=random.next(), tts=random.next(), vision=0),
            actual_spend_usd=0,
        ),
        ended_at=datetime(2026, 11, 10, 5, 0, 0, tzinfo=UTC),
        now=datetime(2026, 11, 10, 5, 0, 1, tzinfo=UTC),
        sign_file_url=signer,
    )

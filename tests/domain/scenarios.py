"""End-to-end domain scenarios for the golden records: real validators -> candidate history -> resolver -> outcome ->
record. Every input is fixed (explicit seq and times), so the output is byte-for-byte reproducible."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from app.domain.conflicts import Candidate, resolve_field
from app.domain.fields import RECORD_FIELD_IDS
from app.domain.outcome import OutcomeFacts, ReviewFlag, decide_outcome
from app.domain.record import (
    CostBreakdown,
    Engagement,
    PreviousRevision,
    RecordCost,
    RecordInput,
)
from app.domain.validators.chat_fields import validate_email, validate_serial_number, validate_service_centre
from app.domain.validators.result import ValidationResult
from app.domain.validators.voice_fields import (
    validate_device_model,
    validate_device_type,
    validate_problem_description,
    validate_problem_started_at,
    validate_urgency,
)

TODAY = "2026-11-10"


def signer(file_id: str) -> str:
    return f"https://repair.example.com/files/{file_id}?exp=1762800000&sig=TESTSIGNATURE"


SESSION_ID = "0b6f4c1e-3d2a-4e8b-9a71-5c2d8e9f1a3b"


def iso_z(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


class History:
    def __init__(self) -> None:
        self._seq = 0
        self.by_field: dict[str, list[Candidate]] = {}

    def add(self, field: str, source: str, result: ValidationResult[Any], user_confirmed: bool = False) -> History:
        """Records one answer as the controller would: the validator's verdict, with chatOnly call values kept
        unverified."""
        self._seq += 1
        chat_only_heard = source == "call" and field in ("serialNumber", "email") and result.status == "valid"
        candidate = Candidate(
            source=source,  # type: ignore[arg-type]
            seq=self._seq,
            collected_at=iso_z(datetime(2026, 11, 10, 4, 30, 0, tzinfo=UTC) + timedelta(seconds=20 * self._seq)),
            status="unverified" if chat_only_heard else result.status,  # type: ignore[arg-type]
            normalized=result.normalized if result.status == "valid" else None,
            user_confirmed=user_confirmed,
        )
        self.by_field[field] = [*self.by_field.get(field, []), candidate]
        return self

    def resolve(self) -> dict[str, Any]:
        return {i: resolve_field(i, self.by_field.get(i, [])) for i in RECORD_FIELD_IDS}


def file_result(file_id: str, mime: str, size: int, hex_char: str) -> ValidationResult[Any]:
    return ValidationResult(
        "valid", normalized={"fileId": file_id, "mime": mime, "size": size, "sha256": hex_char * 64}
    )


def call_answers(history: History) -> History:
    """The voice part every scenario shares: what the user said on the call."""
    return (
        history.add("deviceType", "call", validate_device_type("my phone"))
        .add("deviceModel", "call", validate_device_model("iPhone 14 Pro"))
        .add(
            "problemDescription",
            "call",
            validate_problem_description(
                "the screen flickers and goes black after a minute, it started after I dropped it"
            ),
        )
        .add("problemStartedAt", "call", validate_problem_started_at("last Tuesday", today=TODAY))
        .add("urgency", "call", validate_urgency("I need it for work tomorrow"))
    )


def build_input(
    history: History,
    trigger: str,
    *,
    stored_flags: list[ReviewFlag] | None = None,
    attempts: dict[str, int] | None = None,
    submit_confirmed_at: str | None = None,
    previous_revision: PreviousRevision | None = None,
    revision: int = 1,
) -> RecordInput:
    fields = history.resolve()
    decision = decide_outcome(
        OutcomeFacts(
            fields=fields,
            attempts=attempts or {},
            submit_confirmed=bool(submit_confirmed_at),
            stored_flags=stored_flags or [],
        ),
        trigger,  # type: ignore[arg-type]
        auto_complete_on_idle=True,
    )
    if not decision.finalize:
        raise RuntimeError(decision.reason)
    return RecordInput(
        session_id=SESSION_ID,
        revision=revision,
        previous_revision=previous_revision,
        outcome=decision.outcome,  # type: ignore[arg-type]
        outcome_reason=decision.reason,
        review_flags=decision.review_flags,
        missing_required=decision.missing_required,
        fields=fields,
        submit_confirmed_at=submit_confirmed_at,
        engagement=Engagement(calls=1, call_seconds=212, chat_messages=9, chat_inputs_submitted=6, invalid_attempts=1),
        cost=RecordCost(
            cost_usd=0.0123,
            cost_breakdown_usd=CostBreakdown(stt=0.004, llm=0.0021, tts=0.0062, vision=0),
            actual_spend_usd=0,
        ),
        ended_at=datetime(2026, 11, 10, 4, 46, 40, tzinfo=UTC),
        now=datetime(2026, 11, 10, 4, 46, 41, tzinfo=UTC),
        sign_file_url=signer,
    )


def _completed() -> RecordInput:
    """Everything collected; the email heard on the call matches the typed one; the user confirmed. Revision 2."""
    history = (
        call_answers(History())
        .add("email", "call", validate_email("asha.rao@example.com"))
        .add("serialNumber", "chat", validate_serial_number("35 209900 176148"))
        .add("serialNumber", "chat", validate_serial_number("35 209900 176148 1"))
        .add("purchaseInvoice", "chat", file_result("fInvoice7Kq2Lm9x", "application/pdf", 182233, "c"))
        .add("serviceCentre", "chat", validate_service_centre("blr-koramangala"))
        .add("email", "chat", validate_email("Asha.Rao@Example.com"))
        .add("additionalPhotos", "chat", ValidationResult("skipped"))
        .add("additionalNotes", "chat", ValidationResult("valid", normalized="Please call before visiting."))
    )
    return build_input(
        history,
        "confirmSubmit",
        submit_confirmed_at="2026-11-10T04:46:30Z",
        revision=2,
        previous_revision=PreviousRevision(1, "partial"),
    )


def _partial() -> RecordInput:
    """The user left after the call: no invoice; the email was only said aloud; the idle timer fired."""
    history = (
        call_answers(History())
        .add("email", "call", validate_email("asha.rao@example.com"))
        .add("serialNumber", "chat", validate_serial_number("352099001761481"))
        .add("serviceCentre", "chat", validate_service_centre("mum-dadar"))
    )
    return build_input(history, "idleTimeout")


def _opted_out() -> RecordInput:
    """The user asked to stop on the call and confirmed."""
    history = (
        History()
        .add("deviceType", "call", validate_device_type("laptop"))
        .add("deviceModel", "call", validate_device_model("Dell XPS 13"))
        .add("problemDescription", "call", validate_problem_description("it's broken"))
    )
    return build_input(history, "optOutConfirmed")


def _needs_review() -> RecordInput:
    """Swollen battery reported (R-1), the typed IMEI differs from the one the user read back and confirmed on the call
    (R-2), and the urgency typed in chat differs from the spoken one (narrative: kept as an addendum)."""
    history = (
        call_answers(History())
        .add("serialNumber", "call", validate_serial_number("490154203237518"), True)
        .add("serialNumber", "chat", validate_serial_number("352099001761481"))
        .add("urgency", "chat", validate_urgency("normal"))
        .add("purchaseInvoice", "chat", file_result("fInvoice7Kq2Lm9x", "image/jpeg", 98211, "d"))
        .add(
            "additionalPhotos",
            "chat",
            ValidationResult(
                "valid",
                normalized=[{"fileId": "fPhotoAa11Bb22", "mime": "image/png", "size": 51200, "sha256": "e" * 64}],
            ),
        )
        .add("serviceCentre", "chat", validate_service_centre("del-saket"))
        .add("email", "chat", validate_email("asha+claims@example.co.in"))
        .add("additionalNotes", "chat", ValidationResult("skipped"))
    )
    return build_input(
        history,
        "confirmSubmit",
        submit_confirmed_at="2026-11-10T04:46:30Z",
        stored_flags=[ReviewFlag("R-1", "safety: user reports the battery is swelling")],
    )


SCENARIOS: dict[str, Callable[[], RecordInput]] = {
    "completed": _completed,
    "partial": _partial,
    "optedOut": _opted_out,
    "needsReview": _needs_review,
}

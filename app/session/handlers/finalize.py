"""Finalization (P6-T01, D16, D17): snapshot -> resolve fields -> decide the outcome -> build and validate the record
(engagement, cost) -> effects that write revision n and finalize the session, in the command's transaction.

``finalize_effects`` is pure and shared: the ``Finalize`` command runs it for a trigger on its own (the token-gated
testFinalize, the idle timer in P7-T01), and SubmitChatInput runs it in the same command as the answer that triggers it
(Yes on "Submit claim?" or on "Stop your claim?"), so the answer and the record commit together.

Persistence (P7-T02, D17): revision = current_revision + 1 is inserted with the session update, the outbox row and the
``session.finalized`` event in one transaction (commands.py; UNIQUE(session_id, revision) makes a second insert of the
same revision fail). A finalization whose content hash equals the latest revision's writes no record and no outbox row:
the session just returns to ``finalized`` with the revision it already has ("unchanged").
"""

from __future__ import annotations

import dataclasses
from collections.abc import Callable, Sequence, Set
from dataclasses import dataclass
from datetime import datetime
from typing import Any, ClassVar

from app.agent.chat_templates import FINALIZED_CANCEL_REASON, finalized_message
from app.db.repos.records import get_latest_revision_hash
from app.db.tx import Tx
from app.domain.engagement import CallSpan, compute_engagement
from app.domain.fields import is_field_id
from app.domain.outcome import FinalizeTrigger, OutcomeFacts, ReviewFlag, decide_outcome
from app.domain.record import (
    BuiltRecord,
    CostBreakdown,
    PreviousRevision,
    RecordCost,
    RecordInput,
    RecordProblem,
    RecordSchemaError,
    build_record,
)
from app.metrics.usage import SessionCost, session_cost
from app.protocol.enums import Outcome, Role
from app.session.commands import Effects, EventDraft, Handler, RecordEffect, TimerEffects
from app.session.ids import new_message_id
from app.session.snapshot import UNSET, Snapshot, SnapshotExtras, resolve_fields
from app.session.timeutil import iso_ms


@dataclass(slots=True)
class FinalizeDeps:
    #: A signed, expiring download URL for a stored file (D10): ``(file_id, now) -> url``.
    sign_file_url: Callable[[str, datetime], str]
    #: AUTO_COMPLETE_ON_IDLE (D16, signed off as true).
    auto_complete_on_idle: bool
    #: The record builder; replaceable in tests to exercise the schema-failure path.
    build: Callable[[RecordInput], BuiltRecord] | None = None


@dataclass(slots=True)
class FinalizeOptions:
    trigger: FinalizeTrigger
    #: When the user tapped Yes on "Submit claim?": ``now`` when the answer is part of this command; otherwise (UNSET)
    #: the latest stored Yes. confirmSubmit without a Yes is refused. None means "no Yes".
    submit_confirmed_at: Any = UNSET
    #: Chat messages and chat answers the calling command writes before finalizing (counted in engagement).
    pending_chat_messages: int = 0
    pending_chat_answers: int = 0
    #: Cards the calling command already closed (not cancelled again).
    handled: Set[str] = frozenset()


#: Where a record broke its schema: JSON pointers and keywords only, never values.
SchemaProblems = list[dict[str, str]]


@dataclass(slots=True)
class FinalizeEffects:
    events: list[EventDraft]
    session: dict[str, Any]
    timers: TimerEffects
    record: RecordEffect | None = None


@dataclass(slots=True)
class FinalizeResult:
    finalized: bool
    reason: str = ""
    revision: int = 0
    outcome: str | None = None
    #: Where the first build broke the schema (paths and keywords only), if it did; the record is then needsReview.
    schema_problems: SchemaProblems | None = None
    #: True when the content equals the latest revision's: no new revision, nothing queued for delivery.
    unchanged: bool = False
    effects: FinalizeEffects | None = None


_RULES = frozenset(["R-1", "R-2", "R-3", "R-4", "R-5"])


def stored_flags(raw: Sequence[Any]) -> list[ReviewFlag]:
    """The review flags stored on the session (R-1, R-4, R-5), ignoring anything malformed."""
    flags: list[ReviewFlag] = []
    for item in raw:
        if isinstance(item, dict) and item.get("rule") in _RULES and isinstance(item.get("reason"), str):
            flags.append(ReviewFlag(rule=item["rule"], reason=item["reason"]))
    return flags


def attempts_by_field(snapshot: Snapshot) -> dict[str, int]:
    """The highest attempt count on each record field's cards (R-3: still invalid after 3 attempts)."""
    attempts: dict[str, int] = {}
    for request in snapshot.requests:
        if not is_field_id(request.field) or request.field == "submitConfirmation":
            continue
        attempts[request.field] = max(attempts.get(request.field, 0), request.attempts)
    return attempts


def stored_submit_confirmation(snapshot: Snapshot) -> datetime | None:
    """When the user last tapped Yes on "Submit claim?" (a stored chat answer) since the session was last reopened, or
    None (D16: a reopened completed session must be confirmed again)."""
    latest: tuple[int, datetime] | None = None
    for c in snapshot.candidates:
        if c.field != "submitConfirmation" or c.source != "chat" or c.status != "valid" or c.normalized is not True:
            continue
        if c.event_seq <= snapshot.history.last_reopened_seq:
            continue
        if latest is None or c.event_seq > latest[0]:
            latest = (c.event_seq, c.collected_at)
    return latest[1] if latest else None


def _record_cost(cost: SessionCost) -> RecordCost:
    breakdown = cost.cost_breakdown_usd
    return RecordCost(
        cost_usd=cost.cost_usd,
        cost_breakdown_usd=CostBreakdown(
            stt=breakdown["stt"], llm=breakdown["llm"], tts=breakdown["tts"], vision=breakdown["vision"]
        ),
        actual_spend_usd=cost.actual_spend_usd,
    )


def finalize_effects(snapshot: Snapshot, options: FinalizeOptions, deps: FinalizeDeps) -> FinalizeResult:
    session, now = snapshot.session, snapshot.now
    if session.status != "active":
        return FinalizeResult(finalized=False, reason=f"session is {session.status}")
    if snapshot.cost is None:
        raise RuntimeError("Finalize needs the session cost: register it with finalize_prepare")
    if snapshot.latest_record is UNSET:
        raise RuntimeError("Finalize needs the latest revision: register it with finalize_prepare")

    fields = resolve_fields(snapshot.candidates)
    flags = stored_flags(session.review_flags)
    submit_confirmed_at = (
        stored_submit_confirmation(snapshot) if options.submit_confirmed_at is UNSET else options.submit_confirmed_at
    )
    # completed means confirmed (PD2): the record must carry the Yes it was confirmed with.
    if options.trigger == "confirmSubmit" and submit_confirmed_at is None:
        return FinalizeResult(
            finalized=False, reason="cannot confirm submission: the user hasn't tapped Yes on Submit claim?"
        )
    decision = decide_outcome(
        OutcomeFacts(
            fields=fields,
            attempts=attempts_by_field(snapshot),
            submit_confirmed=submit_confirmed_at is not None,
            stored_flags=flags,
        ),
        options.trigger,
        auto_complete_on_idle=deps.auto_complete_on_idle,
    )
    if not decision.finalize:
        return FinalizeResult(finalized=False, reason=decision.reason)

    revision = session.current_revision + 1
    engagement = compute_engagement(
        calls=[CallSpan(started_at=c.started_at, ended_at=c.ended_at) for c in snapshot.calls],
        chat_messages=snapshot.history.chat_messages + options.pending_chat_messages + 1,  # + the closing message
        chat_answers=sum(1 for c in snapshot.candidates if c.source == "chat") + options.pending_chat_answers,
        invalid_attempts=sum(r.attempts for r in snapshot.requests),
        now=now,
    )
    input_ = RecordInput(
        session_id=session.id,
        revision=revision,
        previous_revision=(
            PreviousRevision(revision=session.current_revision, outcome=session.outcome)
            if session.current_revision > 0 and session.outcome
            else None
        ),
        outcome=decision.outcome,  # type: ignore[arg-type]
        outcome_reason=decision.reason,
        review_flags=decision.review_flags,
        missing_required=decision.missing_required,
        fields=fields,
        submit_confirmed_at=iso_ms(submit_confirmed_at) if submit_confirmed_at else None,
        engagement=engagement,
        cost=_record_cost(snapshot.cost),
        ended_at=now,
        now=now,
        sign_file_url=lambda file_id: deps.sign_file_url(file_id, now),
    )
    build = deps.build or build_record
    schema_problems: SchemaProblems | None = None
    session_flags = session.review_flags
    try:
        built = build(input_)
    except RecordSchemaError as err:
        # A record that fails its own schema is a bug (D17, R-5): the claim goes to a human, with the reason.
        schema_problems = [_problem(p) for p in err.problems]
        flag = ReviewFlag(rule="R-5", reason="the record failed its schema")
        review_flags = [*decision.review_flags, flag]
        reason = f"needs review: {'; '.join(f'{f.rule} {f.reason}' for f in review_flags)}"
        built = build(
            dataclasses.replace(input_, outcome=Outcome.NEEDS_REVIEW, outcome_reason=reason, review_flags=review_flags)
        )
        session_flags = [*session.review_flags, {"rule": flag.rule, "reason": flag.reason}]
    record, content_hash = built
    # Unchanged content gives no new revision (D17): only when this finalization would have been the next revision of a
    # claim that already has one with the same hash (the hash covers the outcome, so the outcome is the same too).
    latest = snapshot.latest_record
    unchanged = latest is not None and latest.content_hash == content_hash  # type: ignore[union-attr]

    events: list[EventDraft] = []
    # Outstanding cards close with the session (D16: "outstanding cards cancelled"), except on `partial`: the returning
    # user carries on with the card that was open (P7-T05).
    for request in snapshot.requests:
        if record["outcome"] == Outcome.PARTIAL:
            break
        if request.status not in ("open", "queued") or request.id in options.handled:
            continue
        events.append(
            EventDraft(
                type="input.cancelled",
                channel="chat",
                payload={"requestId": request.id, "reason": FINALIZED_CANCEL_REASON},
                input_request_update={"id": request.id, "status": "cancelled"},
            )
        )
    shown_revision = session.current_revision if unchanged else revision
    previous = record["previousRevision"]
    payload: dict[str, Any] = {
        "outcome": record["outcome"],
        "revision": shown_revision,
        "previousRevision": previous["revision"] if previous else None,
        "trigger": options.trigger,
        "reason": record["outcomeReason"],
        "contentHash": content_hash,
    }
    if unchanged:
        payload["unchanged"] = True
    if schema_problems:
        # paths and keywords only: the timeline and the error log.
        payload["schemaProblems"] = [dict(p) for p in schema_problems]
    events.append(EventDraft(type="session.finalized", channel="system", payload=payload))
    events.append(
        EventDraft(
            type="chat.message",
            channel="chat",
            chat_message={"id": new_message_id(), "role": Role.AGENT, "text": finalized_message(record["outcome"])},
        )
    )
    return FinalizeResult(
        finalized=True,
        revision=shown_revision,
        outcome=record["outcome"],
        reason=record["outcomeReason"],
        unchanged=unchanged,
        schema_problems=schema_problems,
        effects=FinalizeEffects(
            events=events,
            session={
                "status": "finalized",
                "outcome": record["outcome"],
                "current_revision": shown_revision,
                "review_flags": session_flags,
            },
            record=None
            if unchanged
            else RecordEffect(revision=revision, outcome=record["outcome"], payload=record, content_hash=content_hash),
            timers=TimerEffects(clear=["noCallStart"]),
        ),
    )


def _problem(problem: RecordProblem) -> dict[str, str]:
    return {"path": problem.path, "keyword": problem.keyword, "message": problem.message}


async def finalize_extras(tx: Tx, session_id: str) -> SnapshotExtras:
    """What a finalization reads beyond the snapshot: the session's cost, and the latest revision (for the dedup check)."""
    # One statement at a time: a transaction is one connection.
    cost = await session_cost(tx, session_id)
    latest_record = await get_latest_revision_hash(tx, session_id)
    return {"cost": cost, "latest_record": latest_record}


async def finalize_prepare(tx: Tx, snapshot: Snapshot, command: Any = None) -> SnapshotExtras:
    """Loads the cost a record needs (P3-T07 ledger), in the command's transaction."""
    return await finalize_extras(tx, snapshot.session.id)


@dataclass(frozen=True, slots=True)
class Finalize:
    type: ClassVar[str] = "Finalize"
    trigger: FinalizeTrigger


def finalize_reply(result: FinalizeResult) -> dict[str, Any]:
    """The reply shape of a finalization (``Finalize`` command and the timers handler)."""
    if not result.finalized:
        return {"finalized": False, "reason": result.reason}
    reply: dict[str, Any] = {"finalized": True, "revision": result.revision, "outcome": result.outcome}
    if result.unchanged:
        reply["unchanged"] = True
    if result.schema_problems:
        reply["schemaProblems"] = result.schema_problems
    return reply


def finalize_handler(deps: FinalizeDeps) -> Handler:
    """The Finalize command: one trigger, nothing else in the same command."""

    def handle(snapshot: Snapshot, command: Finalize) -> Effects:
        result = finalize_effects(snapshot, FinalizeOptions(trigger=command.trigger), deps)
        if not result.finalized or result.effects is None:
            return Effects(reply=finalize_reply(result))
        e = result.effects
        return Effects(
            events=e.events, session=e.session, record=e.record, timers=e.timers, reply=finalize_reply(result)
        )

    return handle

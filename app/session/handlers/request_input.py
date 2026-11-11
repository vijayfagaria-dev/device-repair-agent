"""Chat cards (P4-T01): the planner's ``Reconcile`` command and the call agent's ``RequestInput`` command.

Reconcile applies plan_chat under the session lock (one transaction), so the desired state is computed from exactly what
is committed and applied atomically: a second Reconcile right after finds nothing to do and writes nothing.

RequestInput is what the call agent's request_chat_input tool dispatches (P5-T05): it queues a card, and the planner
opens queued cards one at a time. The controller refuses a field that isn't a chat card or is already done.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, ClassVar

import structlog

from app.agent.chat_planner import field_state, is_record_field, next_request_id, plan_chat
from app.agent.chat_templates import ControlField, submit_card
from app.db.repos.sessions import list_active_session_ids
from app.domain.fields import CHAT_FIELDS, FIELDS, OPTIONAL_FIELDS
from app.domain.outcome import missing_required
from app.session.commands import CommandProcessor, Effects, EventDraft, Reaction
from app.session.snapshot import Snapshot


@dataclass(frozen=True, slots=True)
class Reconcile:
    type: ClassVar[str] = "Reconcile"


def reconcile_handler(snapshot: Snapshot, command: Reconcile) -> Effects:
    """Reply: ``{"mode": ChatMode, "changed": bool}``."""
    plan = plan_chat(snapshot)
    return Effects(events=plan.events, reply={"mode": plan.mode, "changed": len(plan.events) > 0})


def reconcile_reaction(processor: CommandProcessor) -> Reaction:
    """The post-commit reaction that keeps every session's chat reconciled (D11): after every command that changed
    something, and on demand (chat connect, boot; ``command`` None). Not after a Reconcile, which already left the
    session reconciled, nor after a no-op, which changed nothing."""

    async def reaction(session_id: str, update: Any, command: Any) -> None:
        if command is not None and command.type == "Reconcile":
            return
        if command is not None and update is None:
            return
        await processor.dispatch(session_id, Reconcile())

    return reaction


async def reconcile_active_sessions(pool: Any, processor: CommandProcessor, log: Any | None = None) -> int:
    """Boot reconciliation (D11, architecture section 5.5 step 3): every active session gets its reconcile, so a card
    that should be open after a crash (for example right after a call ended) is opened before the server takes traffic.
    One session at a time: each is a short transaction, and a failure is logged without stopping the others."""
    ids = await list_active_session_ids(pool)
    for session_id in ids:
        await processor.react(session_id)
    (log or structlog.get_logger()).info("boot reconciliation complete", sessions=len(ids))
    return len(ids)


#: Fields the call agent may send a card for: the chat fields, the optional ones, and the submit confirmation.
_AGENT_CARD_FIELDS = frozenset([*CHAT_FIELDS, *OPTIONAL_FIELDS, ControlField.SUBMIT])


@dataclass(frozen=True, slots=True)
class RequestInput:
    type: ClassVar[str] = "RequestInput"
    field: str


def request_input_handler(snapshot: Snapshot, command: RequestInput) -> Effects:
    """Reply: ``{"status": "queued"|"alreadyPending", "requestId"}`` or ``{"status": "refused", "reason":
    "notActive"|"notAChatField"|"alreadyProvided"|"tooManyAttempts"|"notReady"}``."""
    field = command.field
    if snapshot.session.status != "active":
        return Effects(reply={"status": "refused", "reason": "notActive"})
    if field not in _AGENT_CARD_FIELDS:
        return Effects(reply={"status": "refused", "reason": "notAChatField"})
    pending = next((r for r in snapshot.requests if r.field == field and r.status in ("open", "queued")), None)
    if pending is not None:
        return Effects(reply={"status": "alreadyPending", "requestId": pending.id})

    state = field_state(requests=snapshot.requests, candidates=snapshot.candidates)
    if is_record_field(field):
        status = state.resolved[field].status
        if status in ("valid", "skipped"):
            return Effects(reply={"status": "refused", "reason": "alreadyProvided"})
        if state.stuck(field):
            return Effects(reply={"status": "refused", "reason": "tooManyAttempts"})
        spec = FIELDS[field].card.to_dict()
    else:
        # The confirmation card is only offered when every required field is valid (D16).
        if len(missing_required(state.resolved)) > 0:
            return Effects(reply={"status": "refused", "reason": "notReady"})
        spec = submit_card().to_dict()
    request_id = next_request_id(snapshot, field)
    return Effects(
        events=[
            EventDraft(
                type="input.queued",
                channel="call",
                payload={"by": "agent"},
                input_request={"id": request_id, "field": field, "spec": spec, "status": "queued"},
            )
        ],
        reply={"status": "queued", "requestId": request_id},
    )

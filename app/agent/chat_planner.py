"""The chat planner (P4-T01, D13, architecture section 6): an idempotent reconciler.

``plan_chat`` is pure: from a session snapshot it works out what the session's chat should look like (at most one open
card, the right next card for the mode, obsolete cards cancelled) and returns the effects that get it there, or nothing
when it is already there.

It runs as the ``Reconcile`` command (session/handlers/request_input.py), under the session lock with a fresh snapshot,
after every command, on every chat connect and for every active session at boot (D11). So nothing that must follow a
commit depends on memory: a crash between "the call ended" and "the next card" is repaired by the next run.

Modes:
- waiting: no call yet and the noCallStart deadline hasn't passed (PD10): the user is expected to tap Call.
- inCall: the call agent decides when to send chat cards (request_chat_input -> queued requests, P5); the planner opens
  them one at a time, plus a safety net: if the agent hasn't asked for any chat card within 60 s of the call, the planner
  sends the first one itself, so chat collection isn't gated on the model.
- chat: no call active, and a call has happened or the deadline passed: the planner runs the whole flow (P4-T04).
- closed: the session is finalized or closed: nothing to do (reopening is P7-T05).
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal

from app.agent.chat_templates import (
    STALLED_MESSAGE,
    CardSpec,
    ControlField,
    agent_card_lead_in,
    lead_in,
    submit_card,
    summary_message,
)
from app.db.repos.input_requests import StoredInputRequest
from app.domain.conflicts import ResolvedField
from app.domain.fields import CALL_FIELDS, CHAT_FIELDS, FIELDS, MAX_ATTEMPTS, OPTIONAL_FIELDS, REQUIRED_RECORD_FIELDS
from app.domain.outcome import missing_required
from app.protocol.enums import Role

if TYPE_CHECKING:
    from app.session.commands import EventDraft
    from app.session.snapshot import Snapshot

ChatMode = Literal["waiting", "inCall", "chat", "closed"]

#: If the call agent hasn't sent any chat card this long into a call, the planner sends the first one (P4-T01).
SAFETY_NET_MS = 60_000

#: Fields the chat may ask for: every record field has a card (voice fields have chat fallbacks, PD5).
_RECORD_FIELDS = frozenset([*CALL_FIELDS, *CHAT_FIELDS, *OPTIONAL_FIELDS])


def is_record_field(field_id: str) -> bool:
    return field_id in _RECORD_FIELDS


#: Order of the chat flow: a session that never had a call starts with the device; after a call, the chat fields first.
ORDER_NO_CALL: tuple[str, ...] = (*CALL_FIELDS, *CHAT_FIELDS, *OPTIONAL_FIELDS)
ORDER_AFTER_CALL: tuple[str, ...] = (*CHAT_FIELDS, *CALL_FIELDS, *OPTIONAL_FIELDS)


def chat_mode(snapshot: Snapshot) -> ChatMode:
    if snapshot.session.status != "active":
        return "closed"
    if snapshot.session.active_call_id is not None:
        return "inCall"
    if len(snapshot.calls) > 0 or snapshot.history.chat_started:
        return "chat"
    return "waiting"


def _is_pending(request: StoredInputRequest) -> bool:
    return request.status in ("open", "queued")


def _ms(moment: Any) -> float:
    return moment.timestamp() * 1000


def next_request_id(snapshot: Snapshot, field_id: str) -> str:
    """The next request id for a field: ``req_<field>_<n>`` (protocol.md section 1.1), n counting this session's cards for it."""
    return f"req_{field_id}_{sum(1 for r in snapshot.requests if r.field == field_id) + 1}"


def _draft(type_: str, **fields: Any) -> EventDraft:
    from app.session.commands import EventDraft

    return EventDraft(type=type_, channel="chat", **fields)


def _agent_message(text: str) -> dict[str, Any]:
    from app.session.ids import new_message_id

    return {"id": new_message_id(), "role": Role.AGENT, "text": text}


def open_card_drafts(request_id: str, field_id: str, spec: CardSpec, message: str | None) -> list[EventDraft]:
    """The two drafts that open a new card: a short agent message, then the card itself."""
    drafts: list[EventDraft] = []
    if message:
        drafts.append(_draft("chat.message", chat_message=_agent_message(message)))
    drafts.append(
        _draft(
            "input.requested",
            input_request={"id": request_id, "field": field_id, "spec": spec.to_dict(), "status": "open"},
        )
    )
    return drafts


def cancel_draft(request_id: str, reason: str) -> EventDraft:
    return _draft(
        "input.cancelled",
        payload={"requestId": request_id, "reason": reason},
        input_request_update={"id": request_id, "status": "cancelled"},
    )


@dataclass(slots=True)
class FieldState:
    """What the planner knows about each field, derived from the snapshot."""

    resolved: Mapping[str, ResolvedField]
    _cards: Callable[[str], list[StoredInputRequest]] = field(repr=False)

    def stuck(self, field_id: str) -> bool:
        """The controller stopped asking: a card for the field was cancelled after MAX_ATTEMPTS invalid answers (D14)."""
        return any(r.status == "cancelled" and r.attempts >= MAX_ATTEMPTS for r in self._cards(field_id))

    def needs(self, field_id: str) -> bool:
        """The field still needs a card in the chat flow."""
        cards = self._cards(field_id)
        if any(_is_pending(r) for r in cards):
            return False
        # Optional fields are offered once (PD4): answered, skipped or cancelled, they aren't asked again.
        if not FIELDS[field_id].required:
            return len(cards) == 0 and self.resolved[field_id].status == "missing"
        return self.resolved[field_id].status != "valid" and not self.stuck(field_id)


def field_state(*, requests: Any, candidates: Any) -> FieldState:
    from app.session.snapshot import resolve_fields  # lazy: the session package imports this module

    resolved = resolve_fields(candidates)
    return FieldState(resolved=resolved, _cards=lambda field_id: [r for r in requests if r.field == field_id])


def _satisfied_by_call(snapshot: Snapshot, state: FieldState, request: StoredInputRequest) -> bool:
    """A card made obsolete by the call: its field received a valid spoken value after the card was sent (P4-T01 step 3).

    Only an authoritative source cancels a card: a spoken email or serial number is ``unverified`` (chatOnly) and never
    valid, so it never cancels its card. A field the user is re-entering from the edit card was valid before the card was
    sent, so its card stays.
    """
    if not is_record_field(request.field) or state.resolved[request.field].status != "valid":
        return False
    since = _ms(request.created_at)
    return any(
        c.field == request.field and c.source == "call" and c.status == "valid" and _ms(c.collected_at) >= since
        for c in snapshot.candidates
    )


@dataclass(slots=True)
class ChatPlan:
    mode: ChatMode
    events: list[EventDraft] = field(default_factory=list)


def plan_chat(snapshot: Snapshot) -> ChatPlan:
    """The planner: the effects that make the session's chat what it should be. Empty when it already is."""
    mode = chat_mode(snapshot)
    events: list[EventDraft] = []
    if mode == "closed":
        return ChatPlan(mode, events)
    state = field_state(requests=snapshot.requests, candidates=snapshot.candidates)
    handled: set[str] = set()

    # 1. Cards the call made obsolete, open or queued.
    for request in snapshot.requests:
        if _is_pending(request) and _satisfied_by_call(snapshot, state, request):
            events.append(cancel_draft(request.id, "already provided on the call"))
            handled.add(request.id)
    pending = [r for r in snapshot.requests if _is_pending(r) and r.id not in handled]

    # 2. At most one open card: an open one stays until it is answered or cancelled.
    if any(r.status == "open" for r in pending):
        return ChatPlan(mode, events)

    # 3. A queued card opens next: first a card the Stop flow paused (it was open before, so it was updated after it was
    #    created; it comes back without a new lead-in), then the call agent's, oldest first.
    def was_open(request: StoredInputRequest) -> bool:
        return _ms(request.updated_at) > _ms(request.created_at)

    queued_cards = [r for r in pending if r.status == "queued"]
    paused = sorted((r for r in queued_cards if was_open(r)), key=lambda r: _ms(r.updated_at), reverse=True)
    queued = paused[0] if paused else (queued_cards[0] if queued_cards else None)
    if queued is not None:
        resumed = was_open(queued)
        if not resumed and is_record_field(queued.field):
            events.append(_draft("chat.message", chat_message=_agent_message(agent_card_lead_in(queued.field))))
        elif not resumed and queued.field == ControlField.SUBMIT:
            # The agent's "Submit claim?" comes with the summary, like the planner's (protocol.md section 5; P4 review #5).
            events.append(_draft("chat.message", chat_message=_agent_message(summary_message(state.resolved))))
        events.append(
            _draft(
                "input.resumed" if resumed else "input.requested",
                input_request_update={"id": queued.id, "status": "open"},
            )
        )
        return ChatPlan(mode, events)

    if mode == "waiting":
        return ChatPlan(mode, events)

    if mode == "inCall":
        call = next((c for c in snapshot.calls if c.id == snapshot.session.active_call_id), None)
        if call is None:
            call = next((c for c in reversed(snapshot.calls) if c.ended_at is None), None)
        if call is None or _ms(snapshot.now) - _ms(call.started_at) < SAFETY_NET_MS:
            return ChatPlan(mode, events)
        since = _ms(call.started_at)
        asked_this_call = any(_ms(r.created_at) >= since and is_record_field(r.field) for r in snapshot.requests)
        target = None if asked_this_call else next((f for f in CHAT_FIELDS if state.needs(f)), None)
        if target:
            events.extend(
                open_card_drafts(
                    next_request_id(snapshot, target),
                    target,
                    FIELDS[target].card,
                    lead_in(target, in_call=True, after_call=False),
                )
            )
        return ChatPlan(mode, events)

    # 4. Chat mode: the next field the flow needs, in order.
    order = ORDER_AFTER_CALL if len(snapshot.calls) > 0 else ORDER_NO_CALL
    target = next((f for f in order if state.needs(f)), None)
    if target:
        last_end = max([0.0, *[(_ms(c.ended_at) if c.ended_at is not None else 0.0) for c in snapshot.calls]])
        after_call = len(snapshot.calls) > 0 and not any(_ms(r.created_at) > last_end for r in snapshot.requests)
        events.extend(
            open_card_drafts(
                next_request_id(snapshot, target),
                target,
                FIELDS[target].card,
                lead_in(target, after_call=after_call, in_call=False),
            )
        )
        return ChatPlan(mode, events)

    # 5. Nothing left to ask. Every required field valid -> the summary and "Submit claim?" (PD2). Otherwise a required
    #    field couldn't be accepted (stuck after 3 attempts): the claim can't be confirmed (D16), so say so once; the
    #    idle timer then finalizes it for review (R-3, P7-T01).
    if len(missing_required(state.resolved)) == 0:
        events.extend(
            open_card_drafts(
                next_request_id(snapshot, ControlField.SUBMIT),
                ControlField.SUBMIT,
                submit_card(),
                summary_message(state.resolved),
            )
        )
    elif not snapshot.history.chat_stalled and any(state.stuck(f) for f in REQUIRED_RECORD_FIELDS):
        events.append(_draft("chat.stalled", payload={"fields": [f for f in REQUIRED_RECORD_FIELDS if state.stuck(f)]}))
        events.append(_draft("chat.message", chat_message=_agent_message(STALLED_MESSAGE)))
    return ChatPlan(mode, events)

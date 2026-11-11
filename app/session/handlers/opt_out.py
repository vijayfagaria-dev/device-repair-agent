"""OptOutRequested (P4-T05, PD6): the chat header's Stop button.

It finalizes nothing on its own: it pauses the open card (back to ``queued``, so the planner can bring it back) and
opens "Stop your claim?" in its place (protocol.md section 5: it takes priority over the open card). Yes -> optedOut
(SubmitChatInput, finalize); No -> the paused card returns. An active call is told through the committed events; saying
goodbye and ending it is the call engine's (P5-T09).
"""

from __future__ import annotations

from typing import Any

from app.agent.chat_planner import next_request_id, open_card_drafts
from app.agent.chat_templates import ControlField, opt_out_card
from app.session.commands import Effects, EventDraft
from app.session.snapshot import Snapshot

from .chat_input import OptOutRequested
from .submit_chat_input import open_card_ref


def opt_out_handler(snapshot: Snapshot, command: OptOutRequested) -> Effects:
    """Reply: ``{"status": "asked", "requestId"}``, ``{"status": "alreadyAsked", "requestId", "open"?}`` (carries the open
    card, which the socket sends again: the page may have lost track of it) or ``{"status": "notActive"}``."""
    if snapshot.session.status != "active":
        return Effects(reply={"status": "notActive"})
    pending = next(
        (r for r in snapshot.requests if r.field == ControlField.OPT_OUT and r.status in ("open", "queued")), None
    )
    if pending is not None:
        # A second tap: nothing new, but the page gets the open card again in case it isn't showing it.
        reply: dict[str, Any] = {"status": "alreadyAsked", "requestId": pending.id}
        open_ref = open_card_ref(snapshot)
        if open_ref is not None:
            reply["open"] = open_ref
        return Effects(reply=reply)

    events = [
        EventDraft(
            type="optout.requested", channel="chat", payload={"callActive": snapshot.session.active_call_id is not None}
        )
    ]
    open_request = next((r for r in snapshot.requests if r.status == "open"), None)
    if open_request is not None:
        # Paused before the confirm card opens: at most one card is open (input_requests_one_open_idx).
        events.append(
            EventDraft(
                type="input.paused",
                channel="chat",
                payload={"requestId": open_request.id},
                input_request_update={"id": open_request.id, "status": "queued"},
            )
        )
    request_id = next_request_id(snapshot, ControlField.OPT_OUT)
    events.extend(open_card_drafts(request_id, ControlField.OPT_OUT, opt_out_card(), None))
    return Effects(events=events, activity=True, reply={"status": "asked", "requestId": request_id})

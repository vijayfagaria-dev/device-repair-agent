"""Event -> chat message projection (P3-T03) and the wire builders shared with replay: every message is a valid protocol
message (protocol.md section 3.3) with the section 1.1 id. (Port of server/test/ws/chatProjection.test.ts.)"""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

from app.db.repos.events import SessionEvent
from app.domain.fields import FIELDS
from app.protocol.schemas import parse_chat_server_message
from app.ws.chat_projection import (
    chat_message_wire,
    input_request_wire,
    record_wire,
    same_session_state,
    session_state_wire,
    sync_done_wire,
    to_chat_messages,
)


def event(type_: str, payload: dict[str, Any]) -> SessionEvent:
    return SessionEvent(
        session_id="s", seq=3, type=type_, channel="chat", payload=payload, created_at=datetime.fromtimestamp(0, UTC)
    )


def valid(message: Any) -> bool:
    parse_chat_server_message(message)
    return True


class TestToChatMessages:
    def test_projects_each_chat_visible_event_type_to_its_message(self):
        spec = FIELDS["email"].card.to_dict()
        cases = [
            (
                event("chat.message", {"message": {"id": "abc123", "role": "agent", "text": "Hi", "requestId": None}}),
                {"type": "message", "id": "m_abc123", "role": "agent", "text": "Hi"},
            ),
            (
                event(
                    "chat.message",
                    {
                        "message": {
                            "id": "u1",
                            "role": "user",
                            "text": "asha@example.com",
                            "requestId": "req_email_1",
                        }
                    },
                ),
                {
                    "type": "message",
                    "id": "m_u1",
                    "role": "user",
                    "text": "asha@example.com",
                    "requestId": "req_email_1",
                },
            ),
            (
                event(
                    "transcript.final",
                    {"line": {"id": "tu_c1_1", "callId": "c1", "role": "user", "text": "hello", "interrupted": False}},
                ),
                {"type": "transcript", "id": "tu_c1_1", "role": "user", "text": "hello", "final": True},
            ),
            (
                event(
                    "input.requested",
                    {"request": {"id": "req_email_1", "field": "email", "status": "open", "attempts": 0, "spec": spec}},
                ),
                {**spec, "type": "inputRequest", "id": "req_email_1", "field": "email"},
            ),
            (
                event("input.rejected", {"requestId": "req_email_1", "attempt": 2, "message": "Bad"}),
                {"type": "inputError", "id": "err_req_email_1_2", "requestId": "req_email_1", "message": "Bad"},
            ),
            (
                event("input.cancelled", {"requestId": "req_email_1", "reason": "already provided"}),
                {
                    "type": "inputCancel",
                    "id": "cancel_req_email_1",
                    "requestId": "req_email_1",
                    "reason": "already provided",
                },
            ),
        ]
        for input_, expected in cases:
            messages = to_chat_messages(input_)
            assert messages == [expected], input_.type
            for message in messages:
                assert valid(message), input_.type

    def test_projects_session_finalized_to_the_record_message_only_when_the_update_carries_that_revisions_record(self):
        finalized = event("session.finalized", {"outcome": "partial", "revision": 2, "trigger": "idleTimeout"})
        record = {"revision": 2, "payload": {"revision": 2, "outcome": "partial"}}
        messages = to_chat_messages(finalized, record)
        assert messages == [{"type": "record", "id": "rec_2", "record": record["payload"]}]
        for message in messages:
            assert valid(message)
        assert to_chat_messages(finalized) == []  # no record on the update (e.g. a replayed event): nothing to show
        assert to_chat_messages(finalized, {"revision": 1, "payload": {}}) == []  # another revision's record

    def test_projects_nothing_for_events_the_chat_doesnt_show_or_for_malformed_payloads(self):
        for input_ in [
            event("session.created", {"via": "chat"}),
            event("timer.fired", {"kind": "idle"}),
            event("field.candidate", {"candidate": {}}),
            event("chat.message", {"message": "not an object"}),
            event("input.requested", {"request": {"id": "req_x_1", "field": "x", "status": "queued", "spec": {}}}),
            event("input.rejected", {"requestId": "req_x_1"}),  # no attempt number
        ]:
            assert to_chat_messages(input_) == [], input_.type


class TestWireBuilders:
    def test_never_lets_a_stored_spec_override_the_requests_own_type_id_or_field(self):
        card = input_request_wire(
            id="req_email_2",
            field="email",
            spec={"type": "message", "id": "evil", "field": "x", "kind": "email", "label": "E"},
        )
        assert card == {"type": "inputRequest", "id": "req_email_2", "field": "email", "kind": "email", "label": "E"}

    def test_sends_a_user_messages_request_id_but_never_an_agents(self):
        assert "requestId" not in chat_message_wire(id="a", role="agent", text="t", request_id="req_x_1")
        assert chat_message_wire(id="a", role="user", text="t", request_id="req_x_1")["requestId"] == "req_x_1"

    def test_builds_session_state_sync_done_and_record_messages_that_match_the_protocol(self):
        def session(**changes: Any) -> Any:
            values = {"version": 42, "status": "active", "active_call_id": "c1", "outcome": None, "current_revision": 0}
            return SimpleNamespace(**{**values, **changes})

        state = session_state_wire(session())
        assert state == {
            "type": "sessionState",
            "id": "state_42",
            "status": "active",
            "callActive": True,
            "outcome": None,
            "revision": None,
            "voiceAvailable": True,
            "notice": None,
        }
        for message in [state, sync_done_wire(118), record_wire(2, {"revision": 2})]:
            assert valid(message)
        assert same_session_state(state, session_state_wire(session(version=43)))
        assert not same_session_state(state, session_state_wire(session(version=43, active_call_id=None)))

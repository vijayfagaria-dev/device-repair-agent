"""The chat planner (P4-T01) as a pure function: one test per snapshot shape.

The database-backed idempotency and crash-gap tests are in session/test_reconcile.py.
"""

from __future__ import annotations

import itertools
import re
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any

from app.agent.chat_planner import SAFETY_NET_MS, chat_mode, plan_chat
from app.agent.chat_templates import STALLED_MESSAGE
from app.db.repos.calls import Call
from app.db.repos.field_candidates import FieldCandidate
from app.db.repos.input_requests import StoredInputRequest
from app.db.repos.sessions import Session
from app.domain.fields import CHAT_FIELDS, FIELDS, REQUIRED_RECORD_FIELDS
from tests.domain.helpers import VALID_VALUES

SID = "0b6f4c1e-3d2a-4e8b-9a71-5c2d8e9f1a3b"
NOW = datetime(2026, 11, 10, 6, 0, 0, tzinfo=UTC)


def at(seconds: float) -> datetime:
    return NOW + timedelta(seconds=seconds)


def g(obj: Any, key: str) -> Any:
    """An attribute or key (an event draft's parts may be dataclasses or dicts)."""
    if obj is None:
        return None
    return obj.get(key) if isinstance(obj, dict) else getattr(obj, key, None)


def session(**over: Any) -> Session:
    base = {
        "id": SID,
        "status": "active",
        "outcome": None,
        "version": 3,
        "current_revision": 0,
        "language": "en",
        "active_call_id": None,
        "open_request_id": None,
        "review_flags": [],
        "last_activity_at": NOW,
        "created_at": at(-600),
    }
    base.update(over)
    return Session(**base)


def request(id_: str, field: str, status: str, **over: Any) -> StoredInputRequest:
    created_at = over.pop("created_at", at(-300))
    spec = FIELDS[field].card.to_dict() if field in FIELDS else {"kind": "confirm", "label": "?"}
    base = {
        "session_id": SID,
        "id": id_,
        "field": field,
        "spec": spec,
        "status": status,
        "attempts": 0,
        "created_at": created_at,
        "updated_at": created_at,
    }
    base.update(over)
    return StoredInputRequest(**base)


_candidate_id = itertools.count(1)


def candidate(
    field: str, source: str, status: str, collected_at: datetime | None = None, normalized: Any = ...
) -> FieldCandidate:
    cid = next(_candidate_id)
    value = VALID_VALUES.get(field) if normalized is ... else normalized
    return FieldCandidate(
        id=cid,
        session_id=SID,
        event_seq=cid,
        field=field,
        source=source,
        raw=value,
        normalized=value if status in ("valid", "unverified") else None,
        status=status,
        error="bad" if status == "invalid" else None,
        user_confirmed=False,
        collected_at=collected_at or at(-200),
        evidence=None,
    )


def valid_fields(fields: Any, source: str | None = None) -> list[FieldCandidate]:
    """Valid candidates for these fields (call ones for voice fields, chat ones otherwise)."""
    return [
        candidate(f, source or ("call" if FIELDS[f].primary_channel == "call" else "chat"), "valid") for f in fields
    ]


def call(**over: Any) -> Call:
    base = {"id": "c1", "session_id": SID, "started_at": at(-900), "ended_at": at(-800), "end_reason": "user"}
    base.update(over)
    return Call(**base)


CHAT_STARTED = SimpleNamespace(chat_messages=1, chat_started=True, chat_stalled=False, last_reopened_seq=0)


def snapshot(**over: Any) -> SimpleNamespace:
    base: dict[str, Any] = {
        "session": session(),
        "last_seq": 10,
        "history": SimpleNamespace(chat_messages=0, chat_started=False, chat_stalled=False, last_reopened_seq=0),
        "timers": [],
        "requests": [],
        "candidates": [],
        "calls": [],
        "now": NOW,
    }
    base.update(over)
    return SimpleNamespace(**base)


def shape(events: list[Any]) -> list[list[Any]]:
    """A readable summary of the planned effects: [event type, the card or message it concerns]."""
    out = []
    for event in events:
        payload = g(event, "payload")
        concerned = (
            g(g(event, "input_request"), "id")
            or g(g(event, "input_request_update"), "id")
            or g(g(event, "chat_message"), "text")
            or g(payload, "requestId")
        )
        out.append([g(event, "type"), concerned])
    return out


def plan(**over: Any):
    return plan_chat(snapshot(**over))


ALL_REQUIRED = REQUIRED_RECORD_FIELDS
OPTIONAL_DONE = [
    request("req_additionalPhotos_1", "additionalPhotos", "answered"),
    request("req_additionalNotes_1", "additionalNotes", "answered"),
]


class TestMode:
    def test_is_waiting_before_any_call_and_before_the_no_call_start_deadline_then_chat_in_call_during_a_call_closed_once_finalized(
        self,
    ) -> None:
        assert chat_mode(snapshot()) == "waiting"
        assert chat_mode(snapshot(history=CHAT_STARTED)) == "chat"
        assert chat_mode(snapshot(calls=[call()])) == "chat"
        assert chat_mode(snapshot(session=session(active_call_id="c1"), calls=[call(ended_at=None)])) == "inCall"
        assert chat_mode(snapshot(session=session(status="finalized", outcome="completed"))) == "closed"
        assert chat_mode(snapshot(session=session(status="closed"))) == "closed"

    def test_waiting_and_closed_sessions_get_no_card(self) -> None:
        assert plan().events == []
        assert plan(session=session(status="finalized"), history=CHAT_STARTED).events == []


class TestChatModeTheNextCard:
    def test_a_session_that_never_had_a_call_starts_with_the_device_with_a_lead_in_message_as_req_field_1(self) -> None:
        events = plan(history=CHAT_STARTED).events
        assert shape(events) == [
            ["chat.message", "Let's start with your device."],
            ["input.requested", "req_deviceType_1"],
        ]
        spec = g(g(events[1], "input_request"), "spec")
        assert g(g(events[1], "input_request"), "field") == "deviceType"
        assert g(g(events[1], "input_request"), "status") == "open"
        assert g(spec, "kind") == "select" and g(spec, "label") == "What kind of device is it?"

    def test_after_a_call_the_chat_fields_come_first_and_fields_collected_on_the_call_are_never_asked_again(
        self,
    ) -> None:
        candidates = valid_fields(["deviceType", "deviceModel"])
        events = plan(calls=[call()], candidates=candidates).events
        assert shape(events) == [
            [
                "chat.message",
                "Thanks for the call. Let's finish the rest here in chat. Next, the device's serial number or IMEI, so we can look up its warranty.",
            ],
            ["input.requested", "req_serialNumber_1"],
        ]
        # Everything but the two call fields asked, in order, as each is answered.
        asked: list[str] = []
        state = candidates
        for _ in range(12):
            planned = plan(
                calls=[call()], candidates=state, requests=[request(f"req_{f}_1", f, "answered") for f in asked]
            ).events
            nxt = next((e for e in planned if g(e, "input_request")), None)
            if nxt is None or g(g(nxt, "input_request"), "field") == "submitConfirmation":
                break
            field = g(g(nxt, "input_request"), "field")
            asked.append(field)
            if FIELDS[field].required:
                state = [*state, candidate(field, "chat", "valid")]
        assert asked == [
            "serialNumber",
            "purchaseInvoice",
            "serviceCentre",
            "email",
            "problemDescription",
            "problemStartedAt",
            "urgency",
            "additionalPhotos",
            "additionalNotes",
        ]

    def test_the_after_call_lead_in_is_only_on_the_first_card_after_the_call(self) -> None:
        requests = [request("req_serialNumber_1", "serialNumber", "answered", created_at=at(-700))]
        events = plan(calls=[call()], requests=requests, candidates=[candidate("serialNumber", "chat", "valid")]).events
        assert shape(events)[0] == ["chat.message", "Please upload your purchase invoice."]

    def test_an_open_card_stays_nothing_else_opens_at_most_one_open_card(self) -> None:
        assert plan(history=CHAT_STARTED, requests=[request("req_deviceType_1", "deviceType", "open")]).events == []

    def test_numbers_a_fields_next_card_after_its_earlier_ones(self) -> None:
        requests = [
            request("req_deviceType_1", "deviceType", "cancelled"),
            request("req_deviceType_2", "deviceType", "cancelled", attempts=1),
        ]
        assert shape(plan(history=CHAT_STARTED, requests=requests).events)[-1] == [
            "input.requested",
            "req_deviceType_3",
        ]

    def test_optional_fields_are_offered_once_skipped_or_answered_they_arent_asked_again(self) -> None:
        candidates = [*valid_fields(ALL_REQUIRED), candidate("additionalPhotos", "chat", "skipped")]
        requests = [request("req_additionalPhotos_1", "additionalPhotos", "answered")]
        assert shape(plan(history=CHAT_STARTED, candidates=candidates, requests=requests).events)[-1] == [
            "input.requested",
            "req_additionalNotes_1",
        ]

    def test_all_required_valid_and_the_optional_fields_offered_the_summary_and_submit_claim(self) -> None:
        events = plan(history=CHAT_STARTED, candidates=valid_fields(ALL_REQUIRED), requests=OPTIONAL_DONE).events
        assert [g(e, "type") for e in events] == ["chat.message", "input.requested"]
        text = g(g(events[0], "chat_message"), "text")
        assert re.match(r"^Here's your claim:\n• Device type: Phone\n• Device model: Apple iPhone 14 Pro\n", text)
        assert "• Serial number: IMEI 352099001761481" in text
        assert "• Photos: none" in text
        card = g(events[1], "input_request")
        assert (g(card, "id"), g(card, "field")) == ("req_submitConfirmation_1", "submitConfirmation")
        assert g(g(card, "spec"), "kind") == "confirm" and g(g(card, "spec"), "label") == "Submit your claim?"

    def test_after_no_and_an_edit_submit_claim_is_asked_again_as_the_next_card(self) -> None:
        requests = [
            *OPTIONAL_DONE,
            request("req_submitConfirmation_1", "submitConfirmation", "answered"),
            request("req_editField_1", "editField", "answered"),
            request("req_email_1", "email", "answered"),
            request("req_email_2", "email", "answered"),
        ]
        assert shape(plan(history=CHAT_STARTED, candidates=valid_fields(ALL_REQUIRED), requests=requests).events)[
            -1
        ] == ["input.requested", "req_submitConfirmation_2"]

    def test_a_field_stuck_after_3_invalid_attempts_isnt_asked_again_at_the_end_the_planner_says_once_that_it_cant_go_further(
        self,
    ) -> None:
        others = [f for f in ALL_REQUIRED if f != "serialNumber"]
        requests = [*OPTIONAL_DONE, request("req_serialNumber_1", "serialNumber", "cancelled", attempts=3)]
        candidates = [*valid_fields(others), candidate("serialNumber", "chat", "invalid")]
        first = plan(history=CHAT_STARTED, candidates=candidates, requests=requests)
        assert shape(first.events) == [["chat.stalled", None], ["chat.message", STALLED_MESSAGE]]
        assert g(first.events[0], "payload") == {"fields": ["serialNumber"]}
        stalled = SimpleNamespace(chat_messages=1, chat_started=True, chat_stalled=True, last_reopened_seq=0)
        assert plan(history=stalled, candidates=candidates, requests=requests).events == []

    def test_a_stuck_field_doesnt_block_the_fields_after_it(self) -> None:
        requests = [request("req_deviceType_1", "deviceType", "cancelled", attempts=3)]
        assert shape(plan(history=CHAT_STARTED, requests=requests).events)[-1] == [
            "input.requested",
            "req_deviceModel_1",
        ]


class TestCardsMadeObsolete:
    """P4-T01 step 3."""

    def test_a_card_whose_field_the_call_then_provided_is_cancelled_and_the_next_card_opens(self) -> None:
        requests = [request("req_deviceType_1", "deviceType", "open", created_at=at(-100))]
        candidates = [candidate("deviceType", "call", "valid", at(-50))]
        assert shape(plan(history=CHAT_STARTED, requests=requests, candidates=candidates).events) == [
            ["input.cancelled", "req_deviceType_1"],
            ["chat.message", "Which model is it exactly?"],
            ["input.requested", "req_deviceModel_1"],
        ]

    def test_a_spoken_email_unverified_never_cancels_the_email_card(self) -> None:
        requests = [request("req_email_1", "email", "open", created_at=at(-100))]
        candidates = [candidate("email", "call", "unverified", at(-50))]
        assert plan(calls=[call()], requests=requests, candidates=candidates).events == []

    def test_a_card_for_a_field_that_was_already_valid_when_the_card_was_sent_the_edit_re_ask_stays_open(self) -> None:
        requests = [request("req_deviceType_2", "deviceType", "open", created_at=at(-100))]
        candidates = [candidate("deviceType", "call", "valid", at(-500))]
        assert plan(calls=[call()], requests=requests, candidates=candidates).events == []

    def test_an_invalid_spoken_value_doesnt_cancel_anything(self) -> None:
        requests = [request("req_urgency_1", "urgency", "open", created_at=at(-100))]
        assert (
            plan(
                calls=[call()], requests=requests, candidates=[candidate("urgency", "call", "invalid", at(-50))]
            ).events
            == []
        )


class TestQueuedCards:
    def test_a_card_the_call_agent_queued_opens_when_nothing_is_open_with_a_lead_in(self) -> None:
        requests = [request("req_email_1", "email", "queued")]
        events = plan(session=session(active_call_id="c1"), calls=[call(ended_at=None)], requests=requests).events
        assert shape(events) == [
            ["chat.message", "I've sent you a box for your email address."],
            ["input.requested", "req_email_1"],
        ]

    def test_a_card_the_stop_flow_paused_comes_back_as_input_resumed_without_a_lead_in(self) -> None:
        paused = request("req_email_1", "email", "queued", created_at=at(-300), updated_at=at(-60))
        requests = [paused, request("req_optOutConfirmation_1", "optOutConfirmation", "answered")]
        assert shape(plan(history=CHAT_STARTED, requests=requests).events) == [["input.resumed", "req_email_1"]]

    def test_a_queued_card_waits_while_another_is_open(self) -> None:
        requests = [request("req_serialNumber_1", "serialNumber", "open"), request("req_email_1", "email", "queued")]
        assert plan(history=CHAT_STARTED, requests=requests).events == []

    def test_a_queued_card_the_call_made_obsolete_is_cancelled_instead_of_opened(self) -> None:
        requests = [request("req_serviceCentre_1", "serviceCentre", "queued", created_at=at(-100))]
        candidates = [candidate("serviceCentre", "call", "valid", at(-50))]
        events = plan(
            session=session(active_call_id="c1"), calls=[call(ended_at=None)], requests=requests, candidates=candidates
        ).events
        assert shape(events) == [["input.cancelled", "req_serviceCentre_1"]]


class TestInCallSafetyNet:
    def in_call(self, started_ago_ms: float, **over: Any):
        return plan(
            session=session(active_call_id="c1"),
            calls=[call(started_at=at(-started_ago_ms / 1000), ended_at=None)],
            **over,
        )

    def test_does_nothing_in_the_first_60_s_of_a_call_the_agent_decides_when_to_send_cards(self) -> None:
        assert self.in_call(SAFETY_NET_MS - 1000).events == []

    def test_sends_the_first_chat_card_itself_after_60_s_if_the_agent_hasnt_sent_any(self) -> None:
        assert shape(self.in_call(SAFETY_NET_MS).events) == [
            ["chat.message", f"While we talk, you can fill this in here: {FIELDS['serialNumber'].card.label}"],
            ["input.requested", "req_serialNumber_1"],
        ]

    def test_skips_chat_fields_already_valid_and_does_nothing_once_the_agent_has_sent_a_card_this_call(self) -> None:
        candidates = [candidate("serialNumber", "chat", "valid")]
        assert shape(self.in_call(SAFETY_NET_MS, candidates=candidates).events)[-1] == [
            "input.requested",
            "req_purchaseInvoice_1",
        ]
        requests = [request("req_email_1", "email", "answered", created_at=at(-10))]
        assert self.in_call(SAFETY_NET_MS * 2, requests=requests).events == []

    def test_never_opens_voice_fields_or_the_confirmation_during_a_call(self) -> None:
        candidates = valid_fields(CHAT_FIELDS)
        assert self.in_call(SAFETY_NET_MS * 5, candidates=candidates).events == []


class TestTemplates:
    def test_the_summary_stays_under_the_2000_character_message_limit_even_with_every_value_at_its_longest(
        self,
    ) -> None:
        from app.agent.chat_templates import summary_message
        from app.session.snapshot import resolve_fields

        long = "x" * 1000
        values: dict[str, Any] = {
            **VALID_VALUES,
            "deviceModel": {"brand": long, "model": long},
            "problemDescription": {"summary": long, "verbatim": long},
            "urgency": {"level": "high", "reason": long},
            "serviceCentre": {"id": "blr-koramangala", "name": long, "city": long},
            "email": f"{'a' * 64}@{'b' * 180}.com",
            "additionalNotes": long,
        }
        fields = resolve_fields([candidate(f, "chat", "valid", at(-10), values[f]) for f in values])
        text = summary_message(fields)
        assert len(text) <= 2000
        assert len(text.split("\n")) == 12


class TestP4ReviewFixes:
    def test_6_declining_stop_brings_back_the_paused_card_not_an_older_card_the_agent_queued(self) -> None:
        agent_queued = request("req_email_1", "email", "queued", created_at=at(-300))
        paused = request("req_serialNumber_2", "serialNumber", "queued", created_at=at(-200), updated_at=at(-60))
        requests = [agent_queued, paused, request("req_optOutConfirmation_1", "optOutConfirmation", "answered")]
        assert shape(plan(history=CHAT_STARTED, requests=requests).events) == [["input.resumed", "req_serialNumber_2"]]

    def test_5_a_submit_claim_card_the_agent_queued_opens_with_the_summary(self) -> None:
        requests = [*OPTIONAL_DONE, request("req_submitConfirmation_1", "submitConfirmation", "queued")]
        events = plan(
            session=session(active_call_id="c1"),
            calls=[call(ended_at=None)],
            candidates=valid_fields(ALL_REQUIRED),
            requests=requests,
        ).events
        assert [g(e, "type") for e in events] == ["chat.message", "input.requested"]
        assert g(g(events[0], "chat_message"), "text").startswith("Here's your claim:")

    def test_2_the_edit_card_leaves_out_narrative_fields_the_call_collected_a_typed_edit_couldnt_change_them_d15(
        self,
    ) -> None:
        from app.agent.chat_templates import editable_fields
        from app.session.snapshot import resolve_fields

        from_call = resolve_fields(valid_fields(ALL_REQUIRED))
        editable = editable_fields(from_call)
        assert "problemDescription" not in editable
        assert [f for f in editable if f in ("problemDescription", "problemStartedAt", "urgency")] == []
        assert {"deviceType", "deviceModel", "email", "additionalNotes"} <= set(editable)
        typed = resolve_fields(valid_fields(ALL_REQUIRED, "chat"))
        assert len(editable_fields(typed)) == 11

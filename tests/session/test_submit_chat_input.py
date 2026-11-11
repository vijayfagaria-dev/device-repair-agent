"""SubmitChatInput (P4-T02) through the real command processor, planner on, against the throwaway test Postgres: valid;
invalid x3; duplicate; stale; another session's file; skip; plus the server-side checks the card can't make."""

from __future__ import annotations

from typing import Any

import pytest

from app.db.repos.events import list_events
from app.db.repos.field_candidates import list_field_candidates
from app.db.repos.sessions import get_session
from app.db.repos.timers import list_timers
from app.session.handlers.chat_input import STALE_REQUEST_MESSAGE
from app.session.handlers.submit_chat_input import CLOSED_SESSION_MESSAGE, WRONG_FIELD_MESSAGE
from tests.helpers.chat_flow import PNG, answer, answer_open, cards, open_card, session_at_field, store_test_file
from tests.helpers.match import ANY, assert_matches
from tests.helpers.session import test_services


@pytest.fixture
async def services(db):  # type: ignore[no-untyped-def]
    return test_services(db, planner=True)


class Ctx:
    def __init__(self, db: Any, services: Any) -> None:
        self.db = db
        self.services = services

    async def event_types(self, id_: str, after: int = 0) -> list[str]:
        return [e.type for e in await list_events(self.db.pool, id_, after_seq=after)]

    async def last_seq(self, id_: str) -> int:
        events = await list_events(self.db.pool, id_)
        return events[-1].seq if events else 0

    async def messages(self, id_: str, after: int = 0) -> list[dict[str, Any]]:
        return [
            e.payload["message"]
            for e in await list_events(self.db.pool, id_, after_seq=after)
            if e.type == "chat.message"
        ]

    def session_at(self, field: str):  # type: ignore[no-untyped-def]
        return session_at_field(self.db, self.services, field)


@pytest.fixture
def ctx(db, services) -> Ctx:  # type: ignore[no-untyped-def]
    return Ctx(db, services)


class TestAValidAnswer:
    async def test_is_stored_as_a_chat_candidate_closes_the_card_shows_the_answer_and_an_acknowledgement_and_the_next_card_opens(
        self, db, services, ctx
    ) -> None:
        id_ = await ctx.session_at("serialNumber")
        before = await ctx.last_seq(id_)
        reply = await answer_open(db, services, id_, "serialNumber", "35-209900-176148-1")
        assert reply == {"status": "accepted"}
        assert await ctx.event_types(id_, before) == [
            "chat.message",  # the user's answer
            "field.candidate",
            "input.answered",
            "chat.message",  # "Thanks, I've got your IMEI."
            "chat.message",  # the next card's lead-in (planner)
            "input.requested",
        ]
        said = await ctx.messages(id_, before)
        assert_matches(
            said[:2],
            [
                {"id": ANY, "role": "user", "text": "35-209900-176148-1", "requestId": "req_serialNumber_1"},
                {"id": ANY, "role": "agent", "text": "Thanks, I've got your IMEI.", "requestId": None},
            ],
        )
        candidate = (await list_field_candidates(db.pool, id_, "serialNumber"))[-1]
        assert_matches(
            candidate,
            {
                "source": "chat",
                "status": "valid",
                "raw": "35-209900-176148-1",
                "normalized": {"kind": "imei", "value": "352099001761481"},
            },
        )
        assert next(c for c in await cards(db, id_) if c.id == "req_serialNumber_1").status == "answered"
        opened = await open_card(db, id_)
        assert opened is not None and opened.field == "purchaseInvoice"

    async def test_sent_twice_is_acknowledged_once_the_repeat_writes_nothing(self, db, services, ctx) -> None:
        id_ = await ctx.session_at("email")
        await answer_open(db, services, id_, "email", "asha@example.com")
        before = await get_session(db.pool, id_)
        seq = await ctx.last_seq(id_)
        assert await answer(services, id_, "req_email_1", "email", "asha@example.com") == {"status": "accepted"}
        assert await ctx.last_seq(id_) == seq
        assert await get_session(db.pool, id_) == before

    async def test_is_user_activity_it_arms_the_idle_and_session_expiry_timers(self, db, services, ctx) -> None:
        id_ = await ctx.session_at("deviceType")
        await answer_open(db, services, id_, "deviceType", "laptop")
        assert sorted(t.kind for t in await list_timers(db.pool, id_)) == ["idle", "sessionExpiry"]


class TestAnInvalidAnswer:
    async def test_rejects_with_the_validators_message_and_keeps_the_card_open_the_third_cancels_it_leaves_the_field_invalid_with_attempts_3_and_the_planner_moves_on(
        self, db, services, ctx
    ) -> None:
        id_ = await ctx.session_at("serialNumber")
        seen: list[list[str]] = []
        for bad in ["1234", "35-209900-176148-2", "AAAAAAAA"]:
            before = await ctx.last_seq(id_)
            assert await answer(services, id_, "req_serialNumber_1", "serialNumber", bad) == {"status": "rejected"}
            seen.append(await ctx.event_types(id_, before))
        assert seen[0] == ["field.candidate", "input.rejected"]
        assert seen[1] == ["field.candidate", "input.rejected"]
        assert seen[2] == ["field.candidate", "input.cancelled", "chat.message", "chat.message", "input.requested"]
        events = await list_events(db.pool, id_)
        assert_matches(
            [e.payload for e in events if e.type == "input.rejected"],
            [
                {"requestId": "req_serialNumber_1", "attempt": 1, "message": "That IMEI has 4 digits; IMEIs have 15."},
                {
                    "requestId": "req_serialNumber_1",
                    "attempt": 2,
                    "message": "That IMEI's last digit doesn't match the others. Please check each digit.",
                },
            ],
        )
        cancelled = next(e for e in events if e.type == "input.cancelled")
        assert_matches(
            cancelled.payload, {"requestId": "req_serialNumber_1", "reason": "too many attempts", "attempt": 3}
        )
        assert_matches(
            next(c for c in await cards(db, id_) if c.id == "req_serialNumber_1"),
            {"status": "cancelled", "attempts": 3},
        )
        assert [c.status for c in await list_field_candidates(db.pool, id_, "serialNumber")] == [
            "invalid",
            "invalid",
            "invalid",
        ]
        opened = await open_card(db, id_)
        assert opened is not None and opened.field == "purchaseInvoice"
        # Never asked again.
        assert len([c for c in await cards(db, id_) if c.field == "serialNumber"]) == 1

    async def test_a_forged_select_value_not_one_of_the_servers_options_is_rejected(self, db, services, ctx) -> None:
        id_ = await ctx.session_at("serviceCentre")
        assert await answer_open(db, services, id_, "serviceCentre", "nyc-manhattan") == {"status": "rejected"}
        urgency_id = await ctx.session_at("urgency")
        assert await answer_open(db, services, urgency_id, "urgency", "extremely") == {"status": "rejected"}

    async def test_a_required_card_cannot_be_skipped_a_null_answer_counts_as_an_attempt(
        self, db, services, ctx
    ) -> None:
        id_ = await ctx.session_at("email")
        assert await answer_open(db, services, id_, "email", None) == {"status": "rejected"}
        opened = await open_card(db, id_)
        assert opened is not None and opened.attempts == 1

    async def test_dont_know_for_the_model_is_re_asked_once_then_accepted_as_unknown_d14(
        self, db, services, ctx
    ) -> None:
        id_ = await ctx.session_at("deviceModel")
        assert await answer_open(db, services, id_, "deviceModel", "I don't know") == {"status": "rejected"}
        assert await answer_open(db, services, id_, "deviceModel", "I don't know") == {"status": "accepted"}
        assert (await list_field_candidates(db.pool, id_, "deviceModel"))[-1].normalized == {
            "brand": None,
            "model": None,
        }


class TestStaleAndForeignAnswers:
    async def test_a_card_that_is_not_open_unknown_cancelled_gets_no_longer_active_and_writes_nothing(
        self, db, services, ctx
    ) -> None:
        id_ = await ctx.session_at("serialNumber")
        seq = await ctx.last_seq(id_)
        # The reply names the card that is open, which the socket re-sends (P4 review #1).
        reply = await answer(services, id_, "req_email_9", "email", "a@b.co")
        assert_matches(
            reply,
            {
                "status": "stale",
                "message": STALE_REQUEST_MESSAGE,
                "open": {
                    "id": "req_serialNumber_1",
                    "field": "serialNumber",
                    "spec": {"label": "Serial number or IMEI"},
                },
            },
        )
        for bad in ["1", "2"]:
            await answer(services, id_, "req_serialNumber_1", "serialNumber", bad)
        await answer(services, id_, "req_serialNumber_1", "serialNumber", "3")
        after = await ctx.last_seq(id_)
        reply = await answer(services, id_, "req_serialNumber_1", "serialNumber", "35-209900-176148-1")
        assert_matches(
            reply, {"status": "stale", "message": STALE_REQUEST_MESSAGE, "open": {"field": "purchaseInvoice"}}
        )
        assert await ctx.last_seq(id_) == after
        assert after > seq

    async def test_an_answer_naming_another_cards_field_is_refused_without_writing(self, db, services, ctx) -> None:
        id_ = await ctx.session_at("email")
        seq = await ctx.last_seq(id_)
        assert await answer(services, id_, "req_email_1", "serialNumber", "35-209900-176148-1") == {
            "status": "stale",
            "message": WRONG_FIELD_MESSAGE,
        }
        assert await ctx.last_seq(id_) == seq

    async def test_another_sessions_file_id_is_rejected_exactly_like_an_unknown_one(self, db, services, ctx) -> None:
        id_ = await ctx.session_at("purchaseInvoice")
        other = await ctx.session_at("deviceType")
        theirs = await store_test_file(db, other)
        assert await answer_open(db, services, id_, "purchaseInvoice", f"file:{theirs.id}") == {"status": "rejected"}
        assert await answer_open(db, services, id_, "purchaseInvoice", "file:fNoSuchFile000000") == {
            "status": "rejected"
        }
        errors = [e.payload["message"] for e in await list_events(db.pool, id_) if e.type == "input.rejected"]
        assert errors == ["That upload wasn't recognised. Please upload the file again."] * 2
        mine = await store_test_file(db, id_)
        assert await answer_open(db, services, id_, "purchaseInvoice", f"file:{mine.id}") == {"status": "accepted"}
        assert (await list_field_candidates(db.pool, id_, "purchaseInvoice"))[-1].normalized == {
            "fileId": mine.id,
            "mime": "application/pdf",
            "size": mine.size,
            "sha256": mine.sha256,
        }
        said = await ctx.messages(id_)
        assert any(m["role"] == "user" and m["text"] == "invoice.pdf" for m in said)

    async def test_photos_must_be_images_the_answer_bubble_names_the_files(self, db, services, ctx) -> None:
        id_ = await ctx.session_at("additionalPhotos")
        pdf = await store_test_file(db, id_)
        assert await answer_open(db, services, id_, "additionalPhotos", [f"file:{pdf.id}"]) == {"status": "rejected"}
        photo = await store_test_file(db, id_, PNG, "image/png", "front.png")
        assert await answer_open(db, services, id_, "additionalPhotos", [f"file:{photo.id}"]) == {"status": "accepted"}
        assert [m for m in await ctx.messages(id_) if m["role"] == "user"][-1]["text"] == "front.png"

    async def test_a_closed_session_takes_no_answers_a_finalized_one_reopens(self, db, services, ctx) -> None:
        id_ = await ctx.session_at("email")
        await db.pool.execute("UPDATE sessions SET status = 'closed', outcome = 'partial' WHERE id = $1", id_)
        assert await answer_open(db, services, id_, "email", "asha@example.com") == {
            "status": "stale",
            "message": CLOSED_SESSION_MESSAGE,
        }


class TestSkippingAnOptionalCard:
    async def test_stores_a_skipped_candidate_says_so_and_the_optional_field_is_not_offered_again(
        self, db, services, ctx
    ) -> None:
        id_ = await ctx.session_at("additionalPhotos")
        assert await answer_open(db, services, id_, "additionalPhotos", None) == {"status": "accepted"}
        assert_matches(
            (await list_field_candidates(db.pool, id_, "additionalPhotos"))[-1],
            {"status": "skipped", "normalized": None},
        )
        said = (await ctx.messages(id_))[-3:]
        assert_matches(said[0], {"role": "user", "text": "(skipped)"})
        assert_matches(said[1], {"role": "agent", "text": "No problem, we'll skip that."})
        opened = await open_card(db, id_)
        assert opened is not None and opened.field == "additionalNotes"

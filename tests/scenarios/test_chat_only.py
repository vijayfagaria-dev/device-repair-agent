"""P4 gate scenarios over real sockets and HTTP (fake nothing but the call side): a session run entirely in chat reaches a
completed revision 1; a call that ended after two fields continues in chat without re-asking; the edit loop after "No";
three invalid answers; opt-out with and without a call (and declining it); upload rejections; a reload mid-way. After every
step: at most one open card, and every server message is a valid protocol message.
(Port of server/test/scenarios/chatOnly.test.ts.)"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from collections.abc import AsyncIterator, Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest

from app.db.repos.records import list_records
from app.db.repos.sessions import get_session
from app.domain.record import validate_record
from app.session.services import SessionServices
from tests.helpers.app import RunningApp, TestSocket, connect, start_app
from tests.helpers.chat_flow import ANSWERS, EXE, PDF, PNG, start_chat
from tests.helpers.db import create_migrated_schema
from tests.helpers.fake import FAKE_SECRET_VALUES
from tests.helpers.match import assert_matches
from tests.helpers.record_oracle import expect_sanitized_record
from tests.helpers.seed import seed_session
from tests.helpers.session import TEST_FILE_URL_SECRET, end_seeded_call, seed_call, test_services
from tests.scenarios.driver import expect_valid_protocol

Msg = dict[str, Any]


class World:
    def __init__(self, db: Any, services: SessionServices, server: RunningApp) -> None:
        self.db = db
        self.services = services
        self.server = server


@pytest.fixture
async def world(test_database_url: str) -> AsyncIterator[World]:
    schema = await create_migrated_schema(test_database_url, "chatonly", max_size=10)
    services = test_services(schema.db, planner=True)
    server = await start_app(
        schema.db, services=services, file_url_secret=TEST_FILE_URL_SECRET, uploads_per_minute=1000
    )
    try:
        yield World(schema.db, services, server)
    finally:
        await server.close()
        await schema.drop()


class Chat:
    """Drives one /chat socket like the page does: waits for the next card, answers it, uploads files."""

    def __init__(self, world: World, session_id: str) -> None:
        self.world = world
        self.session_id = session_id
        self.socket: TestSocket = connect(f"{world.server.ws}/chat?sessionId={session_id}")
        self._read = 0

    @property
    def all(self) -> list[Msg]:
        return self.socket.messages

    async def ready(self) -> Chat:
        """Waits for the end of the replay without consuming it: a replayed card is the next card to answer."""
        await self.socket.opened
        deadline = time.monotonic() + 3
        while not any(m["type"] == "syncDone" for m in self.all):
            if time.monotonic() > deadline:
                raise AssertionError("no syncDone")
            await asyncio.sleep(0.005)
        return self

    async def until(self, test: Callable[[Msg], bool], within: float = 3.0) -> Msg:
        """The next message matching `test` after the ones already consumed."""
        deadline = time.monotonic() + within
        while True:
            for index in range(self._read, len(self.all)):
                if test(self.all[index]):
                    self._read = index + 1
                    return self.all[index]
            if time.monotonic() > deadline:
                raise AssertionError(f"timed out; last messages: {json.dumps(self.all[-4:])}")
            await asyncio.sleep(0.005)

    async def card(self) -> Msg:
        return await self.until(lambda m: m["type"] == "inputRequest")

    async def send(self, message: Msg) -> None:
        await self.socket.send(json.dumps(message))

    async def answer(self, card: Msg, value: Any) -> None:
        await self.invariants()
        await self.send({"type": "inputResponse", "requestId": card["id"], "field": card["field"], "value": value})

    async def upload(self, data: bytes, name: str, content_type: str) -> httpx.Response:
        async with self.world.server.client() as client:
            return await client.post(f"/sessions/{self.session_id}/files", files={"file": (name, data, content_type)})

    async def upload_ref(
        self, data: bytes = PDF, name: str = "invoice.pdf", content_type: str = "application/pdf"
    ) -> str:
        response = await self.upload(data, name, content_type)
        assert response.status_code == 200
        return str(response.json()["url"])

    async def give(self, field: str, value: Any = ...) -> Msg:
        """Answers the open card for `field` with a valid value."""
        card = await self.card()
        assert card["field"] == field
        if value is not ...:
            chosen = value
        elif field == "purchaseInvoice":
            chosen = await self.upload_ref()
        else:
            chosen = ANSWERS.get(field)
        await self.answer(card, chosen)
        return card

    async def invariants(self) -> None:
        """Checked after every step: at most one open card, and the session row agrees with it."""
        db = self.world.db
        rows = await db.pool.fetch(
            "SELECT id FROM input_requests WHERE session_id = $1 AND status = 'open'", self.session_id
        )
        assert len(rows) <= 1
        session = await get_session(db.pool, self.session_id)
        assert (session.open_request_id if session else None) == (rows[0]["id"] if rows else None)

    async def close(self) -> None:
        await self.socket.close()


async def chat_only_session(world: World) -> Chat:
    """A new session (created by the socket, as the browser does) whose noCallStart deadline has passed."""
    chat = await Chat(world, str(uuid.uuid4())).ready()
    await start_chat(world.db, world.services, chat.session_id)
    return chat


NO_CALL_ORDER = [
    "deviceType",
    "deviceModel",
    "problemDescription",
    "problemStartedAt",
    "urgency",
    "serialNumber",
    "purchaseInvoice",
    "serviceCentre",
    "email",
]


async def confirm(chat: Chat, yes: bool) -> Msg:
    summary = await chat.until(lambda m: m["type"] == "message" and str(m["text"]).startswith("Here's your claim:"))
    card = await chat.card()
    assert_matches(card, {"field": "submitConfirmation", "kind": "confirm"})
    await chat.answer(card, yes)
    return summary


class TestChatOnlyMode:
    async def test_a_session_with_zero_calls_reaches_a_completed_revision_1_with_the_record_shown_in_the_chat(
        self, world: World
    ) -> None:
        chat = await chat_only_session(world)
        assert_matches(
            await chat.until(lambda m: m["type"] == "message"),
            {"role": "agent", "text": "No problem if you'd rather not call. We can do everything here in chat."},
        )
        for field in NO_CALL_ORDER:
            await chat.give(field)
        await chat.give("additionalPhotos", None)  # Skip
        await chat.give("additionalNotes", "Please call before visiting.")
        summary = await confirm(chat, True)
        assert "• Email address: asha.rao@example.com" in summary["text"]
        assert "• Notes: Please call before visiting." in summary["text"]

        record = await chat.until(lambda m: m["type"] == "record")
        assert record["id"] == "rec_1"
        validate_record(record["record"])
        expect_sanitized_record(record["record"], FAKE_SECRET_VALUES)
        assert_matches(
            record["record"],
            {"revision": 1, "outcome": "completed", "sessionId": chat.session_id, "engagement": {"calls": 0}},
        )
        assert_matches(
            await chat.until(lambda m: m["type"] == "message"),
            {"text": "Thanks, your claim is submitted. We'll email you with updates."},
        )
        assert_matches(
            await chat.until(lambda m: m["type"] == "sessionState" and m["status"] == "finalized"),
            {"outcome": "completed", "revision": 1},
        )

        records = await list_records(world.db.pool, chat.session_id)
        assert [(r.revision, r.outcome) for r in records] == [(1, "completed")]
        async with world.server.client() as client:
            body = (await client.get(f"/api/sessions/{chat.session_id}/records")).json()
        assert_matches(body, {"records": [{"revision": 1, "outcome": "completed"}]})
        await chat.invariants()
        expect_valid_protocol(chat.all)
        await chat.close()

    async def test_a_call_that_ended_after_two_fields_continues_in_chat_with_no_re_asking(self, world: World) -> None:
        db, services = world.db, world.services
        id_ = str(uuid.uuid4())
        chat = await Chat(world, id_).ready()
        call_id = f"c{id_[:8]}"
        await seed_call(db, id_, call_id, datetime.now(UTC) - timedelta(seconds=90))
        await services.processor.dispatch(id_, {"type": "Test.StartCall", "callId": call_id})
        await services.processor.dispatch(
            id_,
            {
                "type": "Test.Candidate",
                "field": "deviceType",
                "source": "call",
                "raw": "a phone",
                "normalized": "smartphone",
                "status": "valid",
            },
        )
        await services.processor.dispatch(
            id_,
            {
                "type": "Test.Candidate",
                "field": "deviceModel",
                "source": "call",
                "raw": "iPhone 14 Pro",
                "normalized": {"brand": "Apple", "model": "iPhone 14 Pro"},
                "status": "valid",
            },
        )
        await end_seeded_call(db, call_id)
        await services.processor.dispatch(id_, {"type": "Test.EndCall"})

        asked: list[str] = []
        while True:
            card = await chat.card()
            if card["field"] == "submitConfirmation":
                await chat.answer(card, True)
                break
            asked.append(card["field"])
            await chat.answer(
                card, await chat.upload_ref() if card["field"] == "purchaseInvoice" else ANSWERS[card["field"]]
            )
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
        lead = next(
            (m for m in chat.all if m["type"] == "message" and str(m["text"]).startswith("Thanks for the call.")), None
        )
        assert lead is not None
        record = await chat.until(lambda m: m["type"] == "record")
        assert_matches(record["record"], {"outcome": "completed", "engagement": {"calls": 1}})
        assert_matches(
            record["record"]["fields"]["deviceModel"],
            {"source": "call", "value": {"brand": "Apple", "model": "iPhone 14 Pro"}},
        )
        expect_valid_protocol(chat.all)
        await chat.close()

    async def test_no_on_submit_claim_what_would_you_like_to_change_that_field_is_asked_again_submit_claim_again(
        self, world: World
    ) -> None:
        chat = await chat_only_session(world)
        for field in NO_CALL_ORDER:
            await chat.give(field)
        await chat.give("additionalPhotos", None)
        await chat.give("additionalNotes", None)
        await confirm(chat, False)
        edit = await chat.card()
        assert_matches(edit, {"id": "req_editField_1", "field": "editField", "kind": "select"})
        assert "email" in [o["value"] for o in edit["options"]]
        await chat.answer(edit, "email")
        assert_matches(
            await chat.until(lambda m: m["type"] == "message" and m["role"] == "agent"),
            {"text": "Sure. What's the correct email address?"},
        )
        again = await chat.card()
        assert_matches(again, {"id": "req_email_2", "field": "email"})
        await chat.answer(again, "asha.new@example.com")
        summary = await chat.until(lambda m: m["type"] == "message" and str(m["text"]).startswith("Here's your claim:"))
        assert "• Email address: asha.new@example.com" in summary["text"]
        confirm_again = await chat.card()
        assert confirm_again["id"] == "req_submitConfirmation_2"
        await chat.answer(confirm_again, True)
        record = await chat.until(lambda m: m["type"] == "record")
        assert record["record"]["fields"]["email"]["value"] == "asha.new@example.com"
        expect_valid_protocol(chat.all)
        await chat.close()

    async def test_three_invalid_serial_numbers_two_input_errors_then_the_card_closes_the_flow_carries_on_and_no_confirmation_is_offered(
        self, world: World
    ) -> None:
        chat = await chat_only_session(world)
        for field in NO_CALL_ORDER[:5]:
            await chat.give(field)
        serial = await chat.card()
        await chat.answer(serial, "1234")
        assert_matches(
            await chat.until(lambda m: m["type"] == "inputError"),
            {"id": "err_req_serialNumber_1_1", "message": "That IMEI has 4 digits; IMEIs have 15."},
        )
        await chat.answer(serial, "1234")
        assert_matches(await chat.until(lambda m: m["type"] == "inputError"), {"id": "err_req_serialNumber_1_2"})
        await chat.answer(serial, "1234")
        assert_matches(
            await chat.until(lambda m: m["type"] == "inputCancel"),
            {"requestId": "req_serialNumber_1", "reason": "too many attempts"},
        )
        for field in ["purchaseInvoice", "serviceCentre", "email"]:
            await chat.give(field)
        await chat.give("additionalPhotos", None)
        await chat.give("additionalNotes", None)
        await chat.until(
            lambda m: m["type"] == "message" and str(m["text"]).startswith("That's everything I can collect here.")
        )
        await asyncio.sleep(0.15)
        assert [m for m in chat.all if m["type"] == "inputRequest" and m["field"] == "submitConfirmation"] == []
        session = await get_session(world.db.pool, chat.session_id)
        assert session is not None and session.status == "active"  # idle -> needsReview is P7-T01
        expect_valid_protocol(chat.all)
        await chat.close()

    async def test_an_upload_the_server_refuses_leaves_the_card_open_a_good_one_then_answers_it(
        self, world: World
    ) -> None:
        chat = await chat_only_session(world)
        for field in NO_CALL_ORDER[:6]:
            await chat.give(field)
        invoice = await chat.card()
        assert invoice["field"] == "purchaseInvoice"
        refused = await chat.upload(EXE, "invoice.pdf", "application/pdf")
        assert refused.status_code == 415
        heic = await chat.upload(bytes([0, 0, 0, 24]) + b"ftypheic" + bytes(16), "x.heic", "image/heic")
        assert heic.status_code == 415
        await chat.answer(invoice, await chat.upload_ref(PNG, "invoice.png", "image/png"))
        assert_matches(await chat.card(), {"field": "serviceCentre"})
        await chat.close()

    async def test_a_reload_mid_way_replays_the_thread_and_the_same_open_card_and_the_session_carries_on(
        self, world: World
    ) -> None:
        first = await chat_only_session(world)
        for field in NO_CALL_ORDER[:3]:
            await first.give(field)
        open_card = await first.card()
        await first.close()
        await first.socket.closed

        second = await Chat(world, first.session_id).ready()
        sync = next(i for i, m in enumerate(second.all) if m["type"] == "syncDone")
        replayed = second.all[:sync]
        assert [m["id"] for m in replayed if m["type"] == "inputRequest"] == [open_card["id"]]
        assert [m.get("requestId") for m in replayed if m["type"] == "message" and m["role"] == "user"] == [
            "req_deviceType_1",
            "req_deviceModel_1",
            "req_problemDescription_1",
        ]
        # The replayed card is the one to answer, and the session goes on from there.
        await second.give("problemStartedAt")
        assert_matches(await second.card(), {"field": "urgency"})
        expect_valid_protocol(second.all)
        await second.close()


class TestOptOutFromChat:
    async def test_stop_pauses_the_open_card_and_asks_to_confirm_no_brings_the_same_card_back_stop_again_and_yes_opted_out(
        self, world: World
    ) -> None:
        chat = await chat_only_session(world)
        for field in NO_CALL_ORDER[:5]:
            await chat.give(field)
        serial = await chat.card()
        assert serial["id"] == "req_serialNumber_1"

        await chat.send({"type": "optOut"})
        ask = await chat.card()
        assert_matches(
            ask,
            {
                "id": "req_optOutConfirmation_1",
                "field": "optOutConfirmation",
                "kind": "confirm",
                "label": "Stop your claim?",
            },
        )
        await chat.invariants()
        await chat.send({"type": "optOut"})  # a double tap asks nothing new: the open card is re-sent
        assert_matches(await chat.card(), {"id": "req_optOutConfirmation_1"})
        await chat.answer(ask, False)
        assert_matches(
            await chat.until(lambda m: m["type"] == "message" and m["role"] == "agent"),
            {"text": "OK, let's carry on."},
        )
        assert_matches(await chat.card(), {"id": "req_serialNumber_1", "field": "serialNumber"})  # the same card, back

        await chat.send({"type": "optOut"})
        again = await chat.card()
        assert again["id"] == "req_optOutConfirmation_2"
        await chat.answer(again, True)
        assert_matches(await chat.until(lambda m: m["type"] == "inputCancel"), {"requestId": "req_serialNumber_1"})
        record = await chat.until(lambda m: m["type"] == "record")
        validate_record(record["record"])
        expect_sanitized_record(record["record"], FAKE_SECRET_VALUES)
        assert_matches(record["record"], {"revision": 1, "outcome": "optedOut"})
        assert record["record"]["fields"]["deviceType"]["status"] == "valid"  # kept
        # Two confirmation cards (the double tap re-sent the first, it didn't make a new one).
        ids = {m["id"] for m in chat.all if m["type"] == "inputRequest" and m["field"] == "optOutConfirmation"}
        assert ids == {"req_optOutConfirmation_1", "req_optOutConfirmation_2"}
        expect_valid_protocol(chat.all)
        await chat.close()

    async def test_with_a_call_active_yes_produces_an_opted_out_record_ending_the_call_itself_is_the_call_engines(
        self, world: World
    ) -> None:
        # The call is set up before the chat connects: a call row that isn't active yet looks like an ended call, and the
        # connect's reconcile would rightly open a chat card for it (StartCall does both in one command in production).
        db = world.db
        id_ = await seed_session(db.pool)
        call_id = f"c{id_[:8]}"
        await seed_call(db, id_, call_id)
        await world.services.processor.dispatch(id_, {"type": "Test.StartCall", "callId": call_id})
        chat = await Chat(world, id_).ready()
        await chat.send({"type": "optOut"})
        ask = await chat.card()
        assert ask["field"] == "optOutConfirmation"
        await chat.answer(ask, True)
        record = await chat.until(lambda m: m["type"] == "record")
        assert_matches(record["record"], {"outcome": "optedOut", "engagement": {"calls": 1}})
        assert_matches(
            await get_session(db.pool, id_),
            {"status": "finalized", "outcome": "optedOut", "active_call_id": call_id},
        )
        await chat.close()

    async def test_stop_on_a_finalized_claim_does_nothing(self, world: World) -> None:
        chat = await chat_only_session(world)
        await chat.card()  # the first card is still on its way over the socket; count after it
        await world.db.pool.execute(
            "UPDATE sessions SET status = 'finalized', outcome = 'partial' WHERE id = $1", chat.session_id
        )
        count = len(chat.all)
        await chat.send({"type": "optOut"})
        await asyncio.sleep(0.15)
        assert [m for m in chat.all[count:] if m["type"] == "inputRequest"] == []
        await chat.close()


class TestTwoTabs:
    async def test_an_answer_in_one_tab_reaches_the_other_as_the_users_message_with_its_request_id_then_the_next_card(
        self, world: World
    ) -> None:
        a = await chat_only_session(world)
        b = await Chat(world, a.session_id).ready()
        card = await a.card()
        assert_matches(await b.card(), {"id": card["id"]})  # replayed in tab b
        await a.answer(card, ANSWERS["deviceType"])
        assert_matches(
            await b.until(lambda m: m["type"] == "message" and m["role"] == "user"),
            {"requestId": card["id"], "text": "Phone"},
        )
        assert_matches(await b.card(), {"field": "deviceModel"})
        await a.close()
        await b.close()


class TestInboundLimitPerSocket:
    async def test_answers_beyond_20_in_10_s_get_input_error_too_quickly_without_reaching_the_database_the_socket_stays_open(
        self, world: World
    ) -> None:
        db = world.db
        chat = await chat_only_session(world)
        card = await chat.card()
        before = await db.pool.fetchval("SELECT count(*)::int FROM events WHERE session_id = $1", chat.session_id)
        for _ in range(25):
            await chat.send({"type": "inputResponse", "requestId": "req_nope_1", "field": "x", "value": "x"})
        await chat.until(
            lambda m: m["type"] == "inputError" and str(m["message"]).startswith("You're sending answers too quickly")
        )
        # All 25 replies, not a fixed sleep: a slow CI machine takes longer than 200 ms to answer them.
        waited = 0.0
        while sum(1 for m in chat.all if m["type"] == "inputError") < 25 and waited < 10:
            await asyncio.sleep(0.05)
            waited += 0.05
        errors = [m["message"] for m in chat.all if m["type"] == "inputError"]
        assert len([m for m in errors if str(m).startswith("You're sending answers too quickly")]) == 5
        assert len([m for m in errors if m == "This request is no longer active."]) == 20
        after = await db.pool.fetchval("SELECT count(*)::int FROM events WHERE session_id = $1", chat.session_id)
        assert after == before  # stale answers write nothing
        assert chat.socket.is_open
        assert card["field"] == "deviceType"
        await chat.close()


class TestAnswerAfterStopPausedItsCard:
    """P4 review #1."""

    async def test_gets_no_longer_active_followed_by_the_card_that_is_open_and_the_flow_recovers(
        self, world: World
    ) -> None:
        chat = await chat_only_session(world)
        for field in NO_CALL_ORDER[:6]:
            await chat.give(field)
        invoice = await chat.card()
        ref = await chat.upload_ref()  # the upload is slow; meanwhile the user taps Stop
        await chat.send({"type": "optOut"})
        ask = await chat.card()
        assert ask["field"] == "optOutConfirmation"
        await chat.answer(invoice, ref)  # the late answer to the paused card
        assert_matches(
            await chat.until(lambda m: m["type"] == "inputError"),
            {"requestId": invoice["id"], "message": "This request is no longer active."},
        )
        assert_matches(await chat.card(), {"id": ask["id"]})  # re-sent right after the error
        await chat.answer(ask, False)
        assert_matches(await chat.card(), {"id": invoice["id"]})  # resumed
        await chat.answer(invoice, ref)
        assert_matches(await chat.card(), {"field": "serviceCentre"})
        await chat.close()

"""The planner as an idempotent reconciler (P4-T01) against the throwaway test Postgres: a second reconcile writes
nothing; a crash between "the call ended" and "the next card" is repaired at boot and on chat connect; concurrent
reconciles never open two cards; the call agent's RequestInput queues cards the planner opens one at a time."""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from app.db.repos.events import list_events
from app.db.repos.sessions import get_session
from app.db.repos.timers import list_timers
from app.session.ensure_session import NewSessionSettings, ensure_session
from app.session.handlers.request_input import Reconcile, RequestInput, reconcile_active_sessions
from app.session.handlers.timers import TimerFired
from tests.helpers.chat_flow import ANSWERS, answer_open, cards, chat_session, open_card, start_chat
from tests.helpers.seed import seed_session
from tests.helpers.session import SilentLog, end_seeded_call, seed_call, test_services


@pytest.fixture
async def planner(db):  # type: ignore[no-untyped-def]
    return test_services(db, planner=True)


@pytest.fixture
async def crashed(db):  # type: ignore[no-untyped-def]
    """The same database without the planner: a process that crashed before its reaction ran."""
    return test_services(db, planner=False)


def reconcile(services: Any, id_: str) -> Any:
    return services.processor.dispatch(id_, Reconcile())


async def call_ended_without_reaction(db: Any, crashed: Any) -> str:
    """A session whose call took two fields and then ended, with nothing reacting to the end (the crash gap)."""
    id_ = await seed_session(db.pool)
    call_id = f"c{id_[:8]}"
    await seed_call(db, id_, call_id, datetime.now(UTC) - timedelta(seconds=120))
    await crashed.processor.dispatch(id_, {"type": "Test.StartCall", "call_id": call_id})
    for field, normalized in [
        ("deviceType", "smartphone"),
        ("deviceModel", {"brand": "Apple", "model": "iPhone 14 Pro"}),
    ]:
        await crashed.processor.dispatch(
            id_,
            {
                "type": "Test.Candidate",
                "field": field,
                "source": "call",
                "raw": "x",
                "normalized": normalized,
                "status": "valid",
            },
        )
    await end_seeded_call(db, call_id)
    await crashed.processor.dispatch(id_, {"type": "Test.EndCall"})
    return id_


class TestIdempotency:
    async def test_a_second_reconcile_in_a_row_writes_nothing_no_event_no_version_bump(
        self, db, planner, crashed
    ) -> None:
        id_ = await call_ended_without_reaction(db, crashed)
        first = await reconcile(planner, id_)
        assert first.reply == {"mode": "chat", "changed": True}
        session = await get_session(db.pool, id_)
        events = await list_events(db.pool, id_)
        second = await reconcile(planner, id_)
        assert second.reply == {"mode": "chat", "changed": False}
        assert second.update is None
        assert await get_session(db.pool, id_) == session
        assert await list_events(db.pool, id_) == events

    async def test_concurrent_reconciles_and_an_answer_never_leave_two_cards_open(self, db, planner) -> None:
        id_ = await chat_session(db, planner)
        await asyncio.gather(
            *[reconcile(planner, id_) for _ in range(8)],
            answer_open(db, planner, id_, "deviceType", "laptop"),
            *[planner.processor.react(id_) for _ in range(8)],
        )
        open_cards = [c for c in await cards(db, id_) if c.status == "open"]
        assert [c.field for c in open_cards] == ["deviceModel"]
        session = await get_session(db.pool, id_)
        assert session is not None and session.open_request_id == open_cards[0].id


class TestTheCrashGap:
    """P4-T01 acceptance: call ended, next card never sent."""

    async def test_boot_reconciliation_opens_the_card_continuing_in_chat_without_re_asking_what_the_call_collected(
        self, db, planner, crashed
    ) -> None:
        id_ = await call_ended_without_reaction(db, crashed)
        assert await open_card(db, id_) is None
        count = await reconcile_active_sessions(db.pool, planner.processor, SilentLog())
        assert count >= 1
        opened = await open_card(db, id_)
        assert opened is not None and opened.field == "serialNumber"
        lead = [e for e in await list_events(db.pool, id_) if e.type == "chat.message"][-1].payload["message"]["text"]
        assert lead.startswith("Thanks for the call. Let's finish the rest here in chat.")

    @pytest.mark.skip(reason="needs the chat socket (app.ws, agent E): port with the transport tests")
    async def test_a_chat_connect_reconciles_too_the_missing_card_arrives_live_after_sync_done(self) -> None:
        """TS: reconcile.test.ts "a chat connect reconciles too" (startApp + connect helpers)."""

    async def test_boot_reconciliation_leaves_finalized_sessions_and_sessions_still_waiting_for_a_call_alone(
        self, db, planner
    ) -> None:
        waiting = await seed_session(db.pool)
        done = await chat_session(db, planner)
        await db.pool.execute("UPDATE sessions SET status = 'finalized', outcome = 'partial' WHERE id = $1", done)
        done_before = await list_events(db.pool, done)
        await reconcile_active_sessions(db.pool, planner.processor, SilentLog())
        assert len(await list_events(db.pool, waiting)) == 0
        assert await list_events(db.pool, done) == done_before


class TestNoCallStart:
    """PD10, P4-T04."""

    async def test_a_new_session_starts_with_its_deadline_when_it_passes_without_a_call_the_chat_starts_with_the_first_card(
        self, db, planner
    ) -> None:
        id_ = str(uuid.uuid4())
        scheduled: list[datetime] = []
        before = datetime.now(UTC)
        await ensure_session(
            db.pool,
            id_,
            via="chat",
            new_session=NewSessionSettings(no_call_start_ms=120_000, on_timer_scheduled=scheduled.append),
        )
        [timer] = await list_timers(db.pool, id_)
        assert timer.kind == "noCallStart"
        assert timer.due_at >= before + timedelta(milliseconds=120_000)
        assert scheduled == [timer.due_at]

        await start_chat(db, planner, id_)
        types = [e.type for e in await list_events(db.pool, id_)]
        assert types == [
            "session.created",
            "timer.fired",
            "chat.started",
            "chat.message",
            "chat.message",
            "input.requested",
        ]
        opened = await open_card(db, id_)
        assert opened is not None and opened.field == "deviceType"

    async def test_does_nothing_once_a_call_has_happened_the_call_drives_the_session(self, db, planner) -> None:
        id_ = await seed_session(db.pool)
        await seed_call(db, id_, f"c{id_[:8]}")
        await db.pool.execute(
            "INSERT INTO timers (session_id, kind, due_at) VALUES ($1, 'noCallStart', now() - interval '1 second')", id_
        )
        result = await planner.processor.dispatch(id_, TimerFired(kind="noCallStart", due_at=datetime.now(UTC)))
        assert result.reply == {"fired": False, "reason": "notNeeded"}
        assert await list_timers(db.pool, id_) == []

    async def test_existing_sessions_are_not_given_a_timer_when_loaded(self, db) -> None:
        id_ = await seed_session(db.pool)
        await ensure_session(db.pool, id_, via="chat", new_session=NewSessionSettings(no_call_start_ms=1))
        assert await list_timers(db.pool, id_) == []


class TestRequestInput:
    """The call agent's request_chat_input."""

    @staticmethod
    def request(planner: Any, id_: str, field: str) -> Any:
        return planner.processor.dispatch(id_, RequestInput(field=field))

    async def test_queues_the_card_the_planner_opens_it_with_a_lead_in_when_nothing_else_is_open_one_at_a_time(
        self, db, planner
    ) -> None:
        id_ = await seed_session(db.pool)
        call_id = f"c{id_[:8]}"
        await seed_call(db, id_, call_id)
        await planner.processor.dispatch(id_, {"type": "Test.StartCall", "call_id": call_id})
        assert (await self.request(planner, id_, "email")).reply == {"status": "queued", "requestId": "req_email_1"}
        assert (await self.request(planner, id_, "serialNumber")).reply == {
            "status": "queued",
            "requestId": "req_serialNumber_1",
        }
        assert [(c.id, c.status) for c in await cards(db, id_)] == [
            ("req_email_1", "open"),
            ("req_serialNumber_1", "queued"),
        ]
        await answer_open(db, planner, id_, "email", ANSWERS["email"])
        opened = await open_card(db, id_)
        assert opened is not None and opened.id == "req_serialNumber_1"
        lead_ins = [e.payload["message"]["text"] for e in await list_events(db.pool, id_) if e.type == "chat.message"]
        assert "I've sent you a box for your email address." in lead_ins

    async def test_refuses_what_is_not_a_chat_card_is_already_provided_or_pending_or_is_not_ready(
        self, db, planner
    ) -> None:
        id_ = await chat_session(db, planner)
        assert (await self.request(planner, id_, "deviceType")).reply == {
            "status": "refused",
            "reason": "notAChatField",
        }
        assert (await self.request(planner, id_, "submitConfirmation")).reply == {
            "status": "refused",
            "reason": "notReady",
        }
        assert (await self.request(planner, id_, "email")).reply == {"status": "queued", "requestId": "req_email_1"}
        assert (await self.request(planner, id_, "email")).reply == {
            "status": "alreadyPending",
            "requestId": "req_email_1",
        }
        await planner.processor.dispatch(
            id_,
            {
                "type": "Test.Candidate",
                "field": "serviceCentre",
                "source": "chat",
                "raw": "x",
                "normalized": {"id": "blr-koramangala", "name": "K", "city": "B"},
                "status": "valid",
            },
        )
        assert (await self.request(planner, id_, "serviceCentre")).reply == {
            "status": "refused",
            "reason": "alreadyProvided",
        }
        await db.pool.execute("UPDATE sessions SET status = 'finalized', outcome = 'partial' WHERE id = $1", id_)
        assert (await self.request(planner, id_, "purchaseInvoice")).reply == {
            "status": "refused",
            "reason": "notActive",
        }

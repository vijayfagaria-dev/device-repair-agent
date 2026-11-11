"""The four outcomes, reopening, revisions and closing through real user paths (P7), over the real command processor
with the planner on and no transport: the chat answers, the idle and expiry timers and the call commands are dispatched
the way the sockets and the sweeper do. (Port of server/test/scenarios/outcomes.test.ts.)"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from app.db.repos.events import list_events
from app.db.repos.input_requests import list_input_requests
from app.db.repos.outbox import list_outbox
from app.db.repos.records import list_records
from app.db.repos.sessions import get_session
from app.db.repos.timers import Timer, upsert_timer
from app.domain.record import validate_record
from app.protocol.enums import Outcome
from app.session.handlers.call import EndCall, FlagForReview, StartCall
from app.session.handlers.chat_input import OptOutRequested
from app.session.handlers.finalize import Finalize
from app.session.handlers.timers import TimerFired
from tests.helpers.chat_flow import ANSWERS, answer, answer_open, open_card, session_at_field, store_test_file
from tests.helpers.fake import FAKE_SECRET_VALUES
from tests.helpers.match import assert_matches
from tests.helpers.record_oracle import expect_sanitized_record
from tests.helpers.session import test_services


@pytest.fixture
async def services(db):  # type: ignore[no-untyped-def]
    return test_services(db, planner=True)


@pytest.fixture
async def manual(db):  # type: ignore[no-untyped-def]
    """AUTO_COMPLETE_ON_IDLE=false."""
    return test_services(db, planner=True, auto_complete_on_idle=False)


def due_now() -> datetime:
    return datetime.now(UTC) - timedelta(seconds=1)


class Ctx:
    def __init__(self, db: Any, services: Any, manual: Any) -> None:
        self.db = db
        self.services = services
        self.manual = manual

    def run(self, id_: str, command: Any, via: Any = None) -> Any:
        return (via or self.services).processor.dispatch(id_, command)

    async def idle(self, id_: str, via: Any = None) -> Any:
        """The idle timer fires (it is due), as the sweeper would dispatch it."""
        await upsert_timer(self.db.pool, Timer(session_id=id_, kind="idle", due_at=due_now()))
        return await self.run(id_, TimerFired(kind="idle", due_at=datetime.now(UTC)), via)

    def yes(self, id_: str, field: str = "submitConfirmation") -> Any:
        return answer_open(self.db, self.services, id_, field, True)

    async def types(self, id_: str) -> list[str]:
        return [e.type for e in await list_events(self.db.pool, id_)]

    async def count(self, id_: str, type_: str) -> int:
        return len([t for t in await self.types(id_) if t == type_])

    async def finish_cards(self, id_: str) -> None:
        """Answers the cards from the one open now through the end of the flow, up to (not including) Submit claim?."""
        for _ in range(12):
            open_ = await open_card(self.db, id_)
            if open_ is None or open_.field == "submitConfirmation":
                return
            value = (
                f"file:{(await store_test_file(self.db, id_)).id}"
                if open_.field == "purchaseInvoice"
                else ANSWERS[open_.field]
            )
            await answer(self.services, id_, open_.id, open_.field, value)

    def at(self, field: str, via: Any = None) -> Any:
        return session_at_field(self.db, via or self.services, field)


@pytest.fixture
def ctx(db, services, manual) -> Ctx:  # type: ignore[no-untyped-def]
    return Ctx(db, services, manual)


class TestEachOutcomeThroughARealUserPath:
    async def test_completed_yes_on_submit_claim(self, db, ctx) -> None:
        id_ = await ctx.at("submitConfirmation")
        assert_matches(
            await ctx.yes(id_), {"status": "accepted", "finalized": {"revision": 1, "outcome": Outcome.COMPLETED}}
        )
        [record] = await list_records(db.pool, id_)
        assert_matches(
            record.payload,
            {
                "outcome": "completed",
                "revision": 1,
                "previousRevision": None,
                "submitConfirmation": {"confirmed": True, "source": "chat"},
            },
        )
        validate_record(record.payload)
        expect_sanitized_record(record.payload, FAKE_SECRET_VALUES)
        assert_matches(
            await get_session(db.pool, id_), {"status": "finalized", "outcome": "completed", "current_revision": 1}
        )

    async def test_opted_out_the_stop_flow_confirmed(self, db, services, ctx) -> None:
        id_ = await ctx.at("serialNumber")
        await ctx.run(id_, OptOutRequested())
        reply = await answer_open(db, services, id_, "optOutConfirmation", True)
        assert_matches(reply, {"finalized": {"revision": 1, "outcome": Outcome.OPTED_OUT}})
        assert_matches(
            (await list_records(db.pool, id_))[0].payload, {"outcome": "optedOut", "submitConfirmation": None}
        )
        assert await open_card(db, id_) is None  # every card cancelled

    async def test_partial_the_idle_timer_with_required_fields_missing_the_open_card_is_kept_for_the_returning_user(
        self, db, ctx
    ) -> None:
        id_ = await ctx.at("email")
        assert_matches(
            (await ctx.idle(id_)).reply, {"fired": True, "finalized": {"revision": 1, "outcome": Outcome.PARTIAL}}
        )
        [record] = await list_records(db.pool, id_)
        assert_matches(record.payload, {"outcome": "partial", "missingRequired": ["email"]})
        assert "idle timeout with required fields missing" in str(record.payload["outcomeReason"])
        opened = await open_card(db, id_)
        assert opened is not None and opened.field == "email"
        assert_matches(await get_session(db.pool, id_), {"status": "finalized", "outcome": "partial"})

    async def test_needs_review_a_safety_flag_raised_on_the_call_then_the_users_yes_r_1(self, db, ctx) -> None:
        id_ = await ctx.at("submitConfirmation")
        await ctx.run(id_, FlagForReview(kind="safety", reason="battery is swelling"))
        assert_matches(await ctx.yes(id_), {"finalized": {"outcome": Outcome.NEEDS_REVIEW}})
        [record] = await list_records(db.pool, id_)
        assert record.payload["reviewFlags"] == [{"rule": "R-1", "reason": "battery is swelling"}]

    async def test_needs_review_a_required_field_still_invalid_after_3_attempts_then_the_idle_timer_r_3(
        self, db, services, ctx
    ) -> None:
        id_ = await ctx.at("email")
        for _ in range(3):
            await answer_open(db, services, id_, "email", "not an email")
        assert_matches((await ctx.idle(id_)).reply, {"finalized": {"outcome": Outcome.NEEDS_REVIEW}})
        flags = (await list_records(db.pool, id_))[0].payload["reviewFlags"]
        assert_matches(flags, [{"rule": "R-3"}])


class TestIdleTimerWithEverythingButTheConfirmation:
    """D16."""

    async def test_auto_complete_on_idle_true_completed_saying_it_was_not_confirmed(self, db, ctx) -> None:
        id_ = await ctx.at("submitConfirmation")
        assert_matches((await ctx.idle(id_)).reply, {"finalized": {"outcome": Outcome.COMPLETED}})
        assert_matches(
            (await list_records(db.pool, id_))[0].payload,
            {
                "outcome": "completed",
                "outcomeReason": "auto-finalized after inactivity; not explicitly confirmed",
                "submitConfirmation": None,
            },
        )

    async def test_auto_complete_on_idle_false_partial_and_the_submit_card_stays_open_to_continue(
        self, db, manual, ctx
    ) -> None:
        id_ = await ctx.at("submitConfirmation", manual)
        assert_matches((await ctx.idle(id_, manual)).reply, {"finalized": {"outcome": Outcome.PARTIAL}})
        opened = await open_card(db, id_)
        assert opened is not None and opened.field == "submitConfirmation"
        # Returning and tapping Yes reopens and completes in the same command (revision 2).
        reply = await answer_open(db, manual, id_, "submitConfirmation", True)
        assert_matches(reply, {"finalized": {"revision": 2, "outcome": Outcome.COMPLETED}})
        assert [(r.revision, r.outcome) for r in await list_records(db.pool, id_)] == [(1, "partial"), (2, "completed")]

    async def test_the_idle_timer_never_fires_finalization_during_a_call_nor_on_a_finalized_session(
        self, db, ctx
    ) -> None:
        id_ = await ctx.at("email")
        await ctx.run(id_, StartCall(call_id=f"c{id_[:8]}"))
        assert (await ctx.idle(id_)).reply == {"fired": False, "reason": "callActive"}
        assert await list_records(db.pool, id_) == []


class TestSimultaneousTriggers:
    """Serialized: one record."""

    async def test_yes_and_the_idle_timer_at_the_same_moment_give_exactly_one_revision_and_one_outbox_row(
        self, db, services, ctx
    ) -> None:
        for round_ in range(5):
            id_ = await ctx.at("submitConfirmation")
            opened = await open_card(db, id_)
            await upsert_timer(db.pool, Timer(session_id=id_, kind="idle", due_at=due_now()))
            await asyncio.gather(
                answer(services, id_, opened.id if opened else "", "submitConfirmation", True),
                ctx.run(id_, TimerFired(kind="idle", due_at=datetime.now(UTC))),
                ctx.run(id_, Finalize(trigger="testFinalize")),
            )
            assert [r.revision for r in await list_records(db.pool, id_)] == [1], f"round {round_}"
            assert len(await list_outbox(db.pool, id_)) == 1
            assert await ctx.count(id_, "session.finalized") == 1


class TestRevisions:
    """P7-T02."""

    async def test_every_revision_queues_its_delivery_in_the_same_transaction(self, db, ctx) -> None:
        id_ = await ctx.at("email")
        await ctx.idle(id_)
        assert_matches(
            await list_outbox(db.pool, id_), [{"revision": 1, "target": "webhook", "status": "pending", "attempts": 0}]
        )

    async def test_a_crash_before_commit_leaves_no_record_no_outbox_row_no_event_and_the_session_active(
        self, db, ctx
    ) -> None:
        def crash(name: str) -> None:
            if name == "beforeCommit":
                raise RuntimeError("simulated crash")

        crashing = test_services(db, planner=True, failpoint=crash)
        id_ = await ctx.at("email")
        before = await ctx.types(id_)
        await upsert_timer(db.pool, Timer(session_id=id_, kind="idle", due_at=due_now()))
        with pytest.raises(RuntimeError, match="simulated crash"):
            await ctx.run(id_, TimerFired(kind="idle", due_at=datetime.now(UTC)), crashing)
        assert await list_records(db.pool, id_) == []
        assert await list_outbox(db.pool, id_) == []
        assert await ctx.types(id_) == before
        assert_matches(await get_session(db.pool, id_), {"status": "active", "current_revision": 0})
        # The timer is still there, so the next attempt (after the "restart") produces the record exactly once.
        assert_matches((await ctx.idle(id_)).reply, {"finalized": {"revision": 1}})
        assert len(await list_records(db.pool, id_)) == 1

    async def test_a_returning_user_whose_claim_has_not_changed_gets_no_new_revision_the_session_just_finalizes_again(
        self, db, ctx
    ) -> None:
        id_ = await ctx.at("email")
        await ctx.idle(id_)  # partial rev 1
        first = (await list_records(db.pool, id_))[0]
        # The user calls back, says nothing new and leaves: activity, but the claim is the same.
        call_id = f"c{id_[:8]}"
        await ctx.run(id_, StartCall(call_id=call_id))
        assert_matches(await get_session(db.pool, id_), {"status": "active", "current_revision": 1})
        await ctx.run(id_, EndCall(call_id=call_id, reason="hangup"))
        again = await ctx.idle(id_)
        assert_matches(again.reply, {"finalized": {"revision": 1, "outcome": Outcome.PARTIAL, "unchanged": True}})
        assert len(await list_records(db.pool, id_)) == 1
        assert len(await list_outbox(db.pool, id_)) == 1
        assert_matches(await get_session(db.pool, id_), {"status": "finalized", "current_revision": 1})
        assert (await list_records(db.pool, id_))[0].content_hash == first.content_hash
        last = [e for e in await list_events(db.pool, id_) if e.type == "session.finalized"][-1]
        assert (
            await ctx.count(id_, "session.finalized") == 2
        )  # the second finalization is on the timeline, marked unchanged
        assert_matches(last.payload, {"unchanged": True, "revision": 1})

    async def test_a_returning_user_whose_answer_changed_the_claim_gets_revision_2_an_invalid_answer_is_a_change(
        self, db, services, ctx
    ) -> None:
        id_ = await ctx.at("email")
        await ctx.idle(id_)
        await answer_open(db, services, id_, "email", "nope")
        assert_matches((await ctx.idle(id_)).reply, {"finalized": {"revision": 2, "outcome": Outcome.PARTIAL}})
        assert [r.revision for r in await list_records(db.pool, id_)] == [1, 2]


REV1 = "SELECT payload::text, content_hash, created_at FROM records WHERE session_id = $1 AND revision = 1"


class TestReopening:
    """P7-T05."""

    async def test_partial_rev_1_the_user_answers_the_kept_card_completed_rev_2_rev_1_is_byte_identical_afterwards(
        self, db, services, ctx
    ) -> None:
        id_ = await ctx.at("email")
        await ctx.idle(id_)
        rev1 = await db.pool.fetchrow(REV1, id_)

        assert await answer_open(db, services, id_, "email", "asha.rao@example.com") == {"status": "accepted"}
        assert_matches(await get_session(db.pool, id_), {"status": "active"})
        reopened = next(e for e in await list_events(db.pool, id_) if e.type == "session.reopened")
        assert_matches(reopened.payload, {"activity": "chatInput", "previousOutcome": "partial", "revision": 1})
        await ctx.finish_cards(id_)
        assert_matches(await ctx.yes(id_), {"finalized": {"revision": 2, "outcome": Outcome.COMPLETED}})

        records = await list_records(db.pool, id_)
        assert [(r.revision, r.outcome) for r in records] == [(1, "partial"), (2, "completed")]
        assert_matches(
            records[1].payload, {"previousRevision": {"revision": 1, "outcome": "partial"}, "missingRequired": []}
        )
        assert [(o.revision, o.status) for o in await list_outbox(db.pool, id_)] == [(1, "pending"), (2, "pending")]
        after = await db.pool.fetchrow(REV1, id_)
        assert rev1 is not None and after is not None and dict(after) == dict(rev1)
        assert await ctx.count(id_, "session.reopened") == 1

    async def test_a_stale_answer_does_not_reopen_a_chat_reconnect_just_replaying_does_not_reopen(
        self, db, services, ctx
    ) -> None:
        id_ = await ctx.at("email")
        await ctx.idle(id_)
        # A card that isn't the open one: stale, nothing written, still finalized.
        assert_matches(await answer(services, id_, "req_nope_1", "email", "asha.rao@example.com"), {"status": "stale"})
        # A reconnect: the chat socket's connect-time reconcile and replay.
        await services.processor.react(id_)
        assert_matches(await get_session(db.pool, id_), {"status": "finalized"})
        assert await ctx.count(id_, "session.reopened") == 0
        assert len(await list_records(db.pool, id_)) == 1

    async def test_completed_plus_a_new_call_reopens_the_earlier_yes_no_longer_counts_so_the_planner_asks_again_and_the_idle_timer_says_unconfirmed(
        self, db, ctx
    ) -> None:
        id_ = await ctx.at("submitConfirmation")
        await ctx.yes(id_)
        call_id = f"c{id_[:8]}"
        assert (await ctx.run(id_, StartCall(call_id=call_id))).reply == {"status": "started", "returning": False}
        assert_matches(await get_session(db.pool, id_), {"status": "active", "active_call_id": call_id})
        reopened = next(e for e in await list_events(db.pool, id_) if e.type == "session.reopened")
        assert_matches(reopened.payload, {"activity": "callStarted", "previousOutcome": "completed"})
        await ctx.run(id_, EndCall(call_id=call_id, reason="hangup"))
        # Everything valid, but the confirmation was before the reopen: Submit claim? comes back.
        assert_matches(await open_card(db, id_), {"field": "submitConfirmation", "id": "req_submitConfirmation_2"})
        assert_matches((await ctx.idle(id_)).reply, {"finalized": {"revision": 2, "outcome": Outcome.COMPLETED}})
        assert_matches(
            (await list_records(db.pool, id_))[1].payload,
            {
                "outcomeReason": "auto-finalized after inactivity; not explicitly confirmed",
                "submitConfirmation": None,
                "previousRevision": {"revision": 1, "outcome": "completed"},
            },
        )

    async def test_completed_plus_a_new_call_plus_yes_again_the_new_confirmation_is_part_of_the_claim_revision_2_unless_nothing_at_all_differs(
        self, db
    ) -> None:
        now = datetime.now(UTC).timestamp() * 1000
        timed = test_services(db, planner=True, now=lambda: datetime.fromtimestamp(now / 1000, UTC))

        def yes_timed(id_: str) -> Any:
            return answer_open(db, timed, id_, "submitConfirmation", True)

        async def recall(id_: str) -> None:
            call_id = f"c{id_[:8]}{int(now)}"[:20]
            await timed.processor.dispatch(id_, StartCall(call_id=call_id))
            await timed.processor.dispatch(id_, EndCall(call_id=call_id, reason="hangup"))

        later = await session_at_field(db, timed, "submitConfirmation")
        await yes_timed(later)
        now += 60_000
        await recall(later)
        assert_matches(await yes_timed(later), {"finalized": {"revision": 2, "outcome": Outcome.COMPLETED}})
        one, two = await list_records(db.pool, later)

        def confirmed_at(record: Any) -> str:
            confirmation = record.payload["submitConfirmation"] if record else None
            return confirmation["at"] if confirmation else ""

        assert confirmed_at(two) > confirmed_at(one)
        assert confirmed_at(one) != ""
        assert_matches(
            two.payload, {"engagement": {"calls": 1}, "previousRevision": {"revision": 1, "outcome": "completed"}}
        )

        same = await session_at_field(db, timed, "submitConfirmation")
        await yes_timed(same)
        await recall(same)  # no time passes
        assert_matches(await yes_timed(same), {"finalized": {"revision": 1}})
        assert len(await list_records(db.pool, same)) == 1


class TestOptedOutResumeYourClaimFirst:
    """P7-T05."""

    async def opted_out_session(self, db: Any, services: Any, ctx: Ctx) -> str:
        id_ = await ctx.at("serialNumber")
        await ctx.run(id_, OptOutRequested())
        await answer_open(db, services, id_, "optOutConfirmation", True)
        return id_

    @staticmethod
    async def resume_cards(db: Any, id_: str) -> list[Any]:
        return [r for r in await list_input_requests(db.pool, id_) if r.field == "resumeConfirmation"]

    async def test_a_call_is_refused_and_the_chat_gets_the_card_once_no_keeps_the_session_opted_out_with_no_new_revision(
        self, db, services, ctx
    ) -> None:
        id_ = await self.opted_out_session(db, services, ctx)
        refused = {"status": "refused", "reason": "resumeRequired"}
        assert (await ctx.run(id_, StartCall(call_id=f"c{id_[:8]}"))).reply == refused
        assert_matches(await open_card(db, id_), {"field": "resumeConfirmation", "id": "req_resumeConfirmation_1"})
        assert (await ctx.run(id_, StartCall(call_id=f"d{id_[:8]}"))).reply == refused
        assert len(await self.resume_cards(db, id_)) == 1  # not a second card

        assert await answer_open(db, services, id_, "resumeConfirmation", False) == {"status": "accepted"}
        assert_matches(
            await get_session(db.pool, id_), {"status": "finalized", "outcome": "optedOut", "current_revision": 1}
        )
        assert await ctx.count(id_, "session.reopened") == 0
        assert len(await list_records(db.pool, id_)) == 1
        assert len(await list_outbox(db.pool, id_)) == 1

    async def test_yes_reopens_the_planner_carries_on_where_it_left_off_and_the_next_record_is_revision_2_pointing_at_the_opt_out(
        self, db, services, ctx
    ) -> None:
        id_ = await self.opted_out_session(db, services, ctx)
        await ctx.run(id_, StartCall(call_id=f"c{id_[:8]}"))
        assert await answer_open(db, services, id_, "resumeConfirmation", True) == {"status": "accepted"}
        assert_matches(await get_session(db.pool, id_), {"status": "active"})
        reopened = next(e for e in await list_events(db.pool, id_) if e.type == "session.reopened")
        assert_matches(reopened.payload, {"activity": "resumeConfirmed", "previousOutcome": "optedOut"})
        opened = await open_card(db, id_)
        assert opened is not None and opened.field == "serialNumber"  # where it left off
        assert (await ctx.run(id_, StartCall(call_id=f"e{id_[:8]}"))).reply == {"status": "started", "returning": False}
        await ctx.run(id_, EndCall(call_id=f"e{id_[:8]}", reason="hangup"))
        await ctx.idle(id_)
        records = await list_records(db.pool, id_)
        assert [(r.revision, r.outcome) for r in records] == [(1, "optedOut"), (2, "partial")]
        assert_matches(records[1].payload, {"previousRevision": {"revision": 1, "outcome": "optedOut"}})

    async def test_an_answer_to_any_other_card_does_not_reopen_an_opted_out_session(self, db, services, ctx) -> None:
        id_ = await self.opted_out_session(db, services, ctx)
        assert_matches(
            await answer(services, id_, "req_serialNumber_1", "serialNumber", "352099001761481"), {"status": "stale"}
        )
        assert_matches(await get_session(db.pool, id_), {"status": "finalized", "outcome": "optedOut"})


class TestClosed:
    """PD3a."""

    @staticmethod
    async def expire(ctx: Ctx, id_: str) -> Any:
        await upsert_timer(ctx.db.pool, Timer(session_id=id_, kind="sessionExpiry", due_at=due_now()))
        return await ctx.run(id_, TimerFired(kind="sessionExpiry", due_at=datetime.now(UTC)))

    async def test_a_pending_finalization_runs_first_then_the_session_closes_submitting_or_calling_afterwards_reopens_nothing(
        self, db, services, ctx
    ) -> None:
        id_ = await ctx.at("email")
        assert_matches(
            (await self.expire(ctx, id_)).reply, {"fired": True, "closed": True, "finalized": {"revision": 1}}
        )
        assert_matches(
            await get_session(db.pool, id_), {"status": "closed", "outcome": "partial", "current_revision": 1}
        )
        assert await open_card(db, id_) is None  # the kept card is cancelled with the session
        assert len(await list_outbox(db.pool, id_)) == 1

        assert_matches(await answer(services, id_, "req_email_1", "email", "asha.rao@example.com"), {"status": "stale"})
        assert (await ctx.run(id_, StartCall(call_id=f"c{id_[:8]}"))).reply == {"status": "refused", "reason": "closed"}
        assert await ctx.count(id_, "session.reopened") == 0
        assert len(await list_records(db.pool, id_)) == 1
        assert_matches((await ctx.idle(id_)).reply, {"fired": False})  # nothing fires on a closed session

    async def test_a_finalized_session_closes_without_a_new_revision(self, db, ctx) -> None:
        id_ = await ctx.at("submitConfirmation")
        await ctx.yes(id_)
        assert (await self.expire(ctx, id_)).reply == {"fired": True, "closed": True}
        assert_matches(
            await get_session(db.pool, id_), {"status": "closed", "outcome": "completed", "current_revision": 1}
        )
        assert len(await list_records(db.pool, id_)) == 1
        assert_matches((await self.expire(ctx, id_)).reply, {"fired": False})  # already closed: the timer just goes

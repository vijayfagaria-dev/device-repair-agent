"""Full sessions through the real server (P9-T01): the chat socket, the call socket and the fake STT/LLM/TTS driven by one
script, with the invariant checker (<= 1 open card, one running call, contiguous events and revisions, schema-valid
sanitized records, one outbox row per revision, append-only history) run after every step. What the fakes prove is the
server's behaviour across both channels, not that any provider works.
(Port of server/test/scenarios/fullSessions.test.ts.)"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from typing import Any

from app.db.repos.field_candidates import list_field_candidates
from app.db.repos.timers import Timer, upsert_timer
from app.db.repos.transcript_lines import list_transcript_lines
from app.protocol.enums import Outcome
from app.session.handlers.timers import TimerFired
from app.voice.fakes.llm import LlmScript
from tests.helpers.chat_flow import start_chat
from tests.helpers.match import assert_matches
from tests.scenarios.driver import (
    FIVE_VOICE_WORDS,
    Chat,
    Msg,
    Rig,
    Run,
    expect_valid_protocol,
    five_voice_fields,
    save,
    wait,
)

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


async def chat_only_run(rig: Rig) -> Run:
    """A session whose chat has started without a call (the noCallStart deadline passed, PD10)."""
    run = await rig.new_run()
    await start_chat(rig.db, rig.services, run.id)
    return run


async def fire_idle(rig: Rig, run: Run) -> None:
    """The idle timer fires, as the sweeper would dispatch it."""
    await upsert_timer(
        rig.db.pool, Timer(session_id=run.id, kind="idle", due_at=datetime.now(UTC) - timedelta(seconds=1))
    )
    await rig.services.processor.dispatch(run.id, TimerFired(kind="idle", due_at=datetime.now(UTC)))
    await run.step("after the idle timer")


async def answer_what_comes(chat: Chat) -> list[str]:
    """Answers every card that comes, until none does (for flows that never offer Submit claim?)."""
    answered: list[str] = []
    for _ in range(14):
        try:
            card = await chat.until(lambda m: m["type"] == "inputRequest", 0.7)
        except AssertionError:
            return answered
        assert card["field"] != "submitConfirmation", "no Submit claim? in this flow"
        await chat.answer(card, await chat.value_for(card["field"]))
        answered.append(card["field"])
    return answered


async def confirm(run: Run, yes: bool = True) -> Msg:
    card = await run.chat.card("submitConfirmation")
    await run.chat.answer(card, yes)
    return await run.chat.until(lambda m: m["type"] == "record")


async def voice_call_with_fields(run: Run, extra_first_turn: list[tuple[str, str, str]] | None = None) -> Any:
    """A call where the model saves all five voice fields and then asks the user to use the chat for the serial number."""
    extra = extra_first_turn or []
    call = await run.start_call()
    await call.say(
        # What the customer says includes every extra value's evidence: the model may only save what was said.
        " ".join([FIVE_VOICE_WORDS, *(args[2] for args in extra)]),
        LlmScript(tool_calls=[*five_voice_fields(), *(save(*args) for args in extra)]),
        LlmScript(tool_calls=[{"name": "request_chat_input", "args": {"field": "serialNumber"}}]),
        LlmScript(text="I've sent a box to the chat for your serial number. Please type it in there."),
    )
    return call


def record_fields(record: Msg) -> dict[str, Any]:
    return record["record"]["fields"]


class TestHappyPath:
    async def test_call_collects_the_voice_fields_and_sends_a_card_hang_up_chat_finishes_confirmed_completed_rev_1(
        self, rig: Rig
    ) -> None:
        run = await rig.new_run()
        call = await voice_call_with_fields(run)
        first = await run.chat.card("serialNumber")  # the card the agent sent while the call is on
        assert first["id"] == "req_serialNumber_1"
        await run.chat.answer(first, "35-209900-176148-1")
        await run.chat.until(lambda m: m["type"] == "message" and m["role"] == "user")
        await call.hang_up()

        await run.chat.fill_rest()
        record = await confirm(run)
        assert_matches(
            record["record"],
            {"revision": 1, "outcome": Outcome.COMPLETED, "missingRequired": [], "engagement": {"calls": 1}},
        )
        fields = record_fields(record)
        assert_matches(fields["deviceModel"], {"source": "call", "status": "valid"})
        assert_matches(fields["serialNumber"], {"source": "chat", "status": "valid"})
        # The call's words are on file, both sides.
        lines = await list_transcript_lines(rig.db.pool, run.id)
        assert {line.role for line in lines} == {"agent", "user"}
        assert next(line for line in lines if line.role == "user").text == FIVE_VOICE_WORDS
        await run.step("at the end")
        expect_valid_protocol(run.chat.all)
        await run.chat.close()

    async def test_a_hang_up_mid_way_the_chat_asks_for_what_the_call_didnt_get_and_completes(self, rig: Rig) -> None:
        run = await rig.new_run()
        call = await run.start_call()
        await call.say(
            "It's my phone",
            LlmScript(tool_calls=[save("deviceType", "smartphone", "it's my phone")]),
            LlmScript(text="And which model is it?"),
        )
        # The turn's effects commit asynchronously: hang up only once the field is stored (a loaded machine is slower).
        await wait(
            lambda: _has_candidate(rig, run, "deviceType"),
            "the spoken field to be stored",
        )
        await call.hang_up()
        first = await run.chat.card()
        assert first["field"] != "deviceType"  # not asked again
        # Whatever the planner needs next, the chat finishes the claim.
        await run.chat.answer(first, await run.chat.value_for(first["field"]))
        await run.chat.fill_rest()
        record = await confirm(run)
        assert_matches(record["record"], {"outcome": "completed", "revision": 1})
        assert_matches((await list_field_candidates(rig.db.pool, run.id, "deviceType"))[0], {"source": "call"})
        await run.chat.close()

    async def test_chat_only_no_call_at_all_completes(self, rig: Rig) -> None:
        run = await chat_only_run(rig)
        for field in NO_CALL_ORDER:
            await run.chat.give(field)
        await run.chat.fill_rest()
        assert_matches((await confirm(run))["record"], {"outcome": "completed", "engagement": {"calls": 0}})
        await run.step("at the end")
        await run.chat.close()


class TestOutcomes:
    async def test_an_invalid_serial_number_x3_the_field_stays_invalid_no_confirmation_is_offered_and_idle_needs_review_r_3(
        self, rig: Rig
    ) -> None:
        run = await chat_only_run(rig)
        for field in NO_CALL_ORDER[:5]:
            await run.chat.give(field)
        card = await run.chat.card("serialNumber")
        for i in range(3):
            await run.chat.answer(card, "nope")
            if i < 2:
                await run.chat.until(lambda m: m["type"] == "inputError")
        await run.chat.until(lambda m: m["type"] == "inputCancel" and m["requestId"] == card["id"])
        rest = await answer_what_comes(run.chat)
        assert "serialNumber" not in rest
        await fire_idle(rig, run)
        [record] = await run.records()
        assert record.outcome == Outcome.NEEDS_REVIEW
        assert_matches(record.payload["reviewFlags"], [{"rule": "R-3"}])
        assert record.payload["fields"]["serialNumber"]["status"] == "invalid"
        await run.chat.close()

    async def test_a_serial_number_never_provided_idle_partial_naming_it_with_its_card_still_open(
        self, rig: Rig
    ) -> None:
        run = await chat_only_run(rig)
        for field in NO_CALL_ORDER[:5]:
            await run.chat.give(field)
        await run.chat.card("serialNumber")
        await fire_idle(rig, run)
        [record] = await run.records()
        assert record.outcome == Outcome.PARTIAL
        assert "serialNumber" in record.payload["missingRequired"]
        assert (await run.session()).status == "finalized"
        # A returning page still sees the card to carry on with.
        again = await run.open_chat()
        assert [m["field"] for m in again.all if m["type"] == "inputRequest"] == ["serialNumber"]
        await again.close()
        await run.chat.close()

    async def test_a_safety_hazard_said_on_the_call_flagged_needs_review_r_1_once_the_user_confirms(
        self, rig: Rig
    ) -> None:
        run = await rig.new_run()
        call = await run.start_call()
        await call.say(
            "The battery is swollen and it smells like burning",
            LlmScript(
                tool_calls=[
                    {
                        "name": "flag_for_review",
                        "args": {"kind": "safety", "reason": "battery swelling and a burning smell"},
                    }
                ]
            ),
            LlmScript(text="That sounds dangerous. Please stop using it."),
        )
        await call.hang_up()
        await run.chat.fill_rest()  # every card from the first, up to Submit claim?
        record = await confirm(run)
        assert_matches(record["record"], {"outcome": Outcome.NEEDS_REVIEW, "reviewFlags": [{"rule": "R-1"}]})
        await run.chat.close()

    async def test_opt_out_on_the_call_confirmed_opted_out_the_call_ends_the_chat_says_so(self, rig: Rig) -> None:
        run = await rig.new_run()
        call = await run.start_call()
        # Opting out ends the call with the server's own goodbye: the model gets no follow-up turn.
        await call.say(
            "Actually, stop. I don't want to continue",
            LlmScript(tool_calls=[{"name": "opt_out", "args": {"confirmed": True}}]),
        )
        await wait(lambda: _status(run, "finalized"), "the opt-out to finalize")
        await wait(lambda: _no_call(run), "the call to end")
        await run.step("after the opt-out")
        assert_matches((await run.records())[0], {"outcome": Outcome.OPTED_OUT})
        await run.chat.until(lambda m: m["type"] == "record")
        await run.chat.close()

    async def test_opt_out_in_the_chat_stop_then_yes_opted_out_with_what_was_collected_kept(self, rig: Rig) -> None:
        run = await chat_only_run(rig)
        for field in NO_CALL_ORDER[:3]:
            await run.chat.give(field)
        await run.chat.card()
        await run.chat.send({"type": "optOut"})
        stop = await run.chat.card("optOutConfirmation")
        await run.chat.answer(stop, True)
        record = await run.chat.until(lambda m: m["type"] == "record")
        assert_matches(record["record"], {"outcome": "optedOut", "revision": 1})
        assert record_fields(record)["deviceModel"]["status"] == "valid"
        await run.chat.close()

    async def test_an_identifier_conflict_the_user_never_resolved_spoken_and_confirmed_vs_typed_needs_review_r_2(
        self, rig: Rig
    ) -> None:
        # NOTE: the "which is correct?" card (protocol.md section 5 conflictChoice) is not implemented anywhere yet: no
        # task owns it. Until then an unresolved identifier conflict goes to review, which is what this asserts.
        run = await rig.new_run()
        call = await run.start_call()
        words = "My IMEI is 3 5 2 0 9 9 0 0 1 7 6 1 4 8 1"
        await call.say(
            words,
            LlmScript(tool_calls=[save("serialNumber", "352099001761481", words, True)]),
            LlmScript(text="Thanks, please type it in the chat."),
        )
        await call.hang_up()
        seen: list[str] = []
        for _ in range(12):
            card = await run.chat.card()
            if card["field"] == "submitConfirmation":
                await run.chat.answer(card, True)  # everything is valid; the conflict decides the outcome
                break
            seen.append(card["field"])
            value = "490154203237518" if card["field"] == "serialNumber" else await run.chat.value_for(card["field"])
            await run.chat.answer(card, value)
        assert "serialNumber" in seen
        record = await run.chat.until(lambda m: m["type"] == "record")
        assert_matches(
            record["record"],
            {
                "outcome": Outcome.NEEDS_REVIEW,
                "reviewFlags": [{"rule": "R-2"}],
                "conflicts": [{"field": "serialNumber", "resolution": "chatValue"}],
            },
        )
        await run.chat.close()


class TestSpokenVersusTyped:
    async def test_a_spoken_email_and_a_different_typed_email_the_typed_one_wins_and_the_conflict_is_recorded(
        self, rig: Rig
    ) -> None:
        run = await rig.new_run()
        call = await voice_call_with_fields(run, [("email", "asha@example.com", "asha at example dot com")])
        await call.hang_up()
        # The agent asks for the email to be typed (it never accepts a spoken one) and for the serial number: both cards.
        typed: list[str] = []
        for _ in range(12):
            card = await run.chat.card()
            if card["field"] == "submitConfirmation":
                run.chat.skip_to_end()
                await run.chat.answer(card, True)
                break
            typed.append(card["field"])
            await run.chat.answer(card, await run.chat.value_for(card["field"]))
        assert "email" in typed
        record = await run.chat.until(lambda m: m["type"] == "record")
        assert_matches(record_fields(record)["email"], {"value": "asha.rao@example.com", "source": "chat"})
        assert_matches(record["record"]["conflicts"], [{"field": "email", "resolution": "chatValue"}])
        await run.chat.close()

    async def test_a_spoken_email_only_it_stays_unverified_its_card_is_open_and_waiting_and_the_record_says_so(
        self, rig: Rig
    ) -> None:
        run = await rig.new_run()
        call = await voice_call_with_fields(run, [("email", "asha@example.com", "asha at example dot com")])
        await call.hang_up()
        card = await run.chat.card()  # what the user was asked to type; they never do
        assert card["field"] == "email"
        await run.step("with the email card open")
        await fire_idle(rig, run)
        [record] = await run.records()
        assert record.outcome == Outcome.PARTIAL
        assert_matches(record.payload["fields"]["email"], {"status": "unverified", "value": "asha@example.com"})
        assert "email" in record.payload["missingRequired"]
        reopened = await run.open_chat()
        assert [m["field"] for m in reopened.all if m["type"] == "inputRequest"] == ["email"]  # kept open
        await reopened.close()
        await run.chat.close()


class TestRevisions:
    async def test_idle_partial_rev_1_the_user_returns_and_finishes_completed_rev_2_rev_1_is_unchanged(
        self, rig: Rig
    ) -> None:
        run = await chat_only_run(rig)
        for field in NO_CALL_ORDER[:5]:
            await run.chat.give(field)
        kept = await run.chat.card("serialNumber")
        await fire_idle(rig, run)
        rev1 = (await run.records())[0].payload

        await run.chat.answer(kept, "35-209900-176148-1")  # the card the partial session kept: the user is back
        await run.chat.until(lambda m: m["type"] == "message" and m["role"] == "user")
        assert (await run.session()).status == "active"
        await run.chat.fill_rest()
        record = await confirm(run)
        assert record["id"] == "rec_2"
        assert_matches(
            record["record"],
            {"revision": 2, "outcome": "completed", "previousRevision": {"revision": 1, "outcome": "partial"}},
        )
        records = await run.records()
        assert [r.revision for r in records] == [1, 2]
        assert records[0].payload == rev1
        await run.step("at the end")
        await run.chat.close()


def thread(messages: list[Msg]) -> list[Any]:
    return [m["id"] for m in messages if m["type"] in ("message", "transcript", "inputRequest")]


class TestOneConversationSeveralScreens:
    async def test_a_double_tap_on_a_card_is_one_answer(self, rig: Rig) -> None:
        run = await chat_only_run(rig)
        card = await run.chat.card()
        value = await run.chat.value_for(card["field"])
        await run.chat.answer(card, value)
        await run.chat.send({"type": "inputResponse", "requestId": card["id"], "field": card["field"], "value": value})
        await run.chat.card()
        await asyncio.sleep(0.1)
        assert len(await list_field_candidates(rig.db.pool, run.id, card["field"])) == 1
        mine = [
            m
            for m in run.chat.all
            if m["type"] == "message" and m["role"] == "user" and m.get("requestId") == card["id"]
        ]
        assert len(mine) == 1
        await run.step("after the double tap")
        await run.chat.close()

    async def test_a_reload_mid_session_shows_the_same_thread_and_the_same_open_card_and_the_flow_continues(
        self, rig: Rig
    ) -> None:
        run = await chat_only_run(rig)
        for field in NO_CALL_ORDER[:4]:
            await run.chat.give(field)
        open_card = await run.chat.card()
        reload = await run.open_chat()
        live = [i for i in thread(run.chat.all) if not str(i).startswith("req_") or i == open_card["id"]]
        assert thread(reload.all) == live
        expect_valid_protocol(reload.all)
        await run.chat.close()
        nxt = await reload.card()
        assert nxt["id"] == open_card["id"]
        await reload.answer(nxt, await reload.value_for(nxt["field"]))
        assert (await reload.card())["field"] != nxt["field"]
        await reload.close()

    async def test_two_tabs_an_answer_in_one_appears_in_the_other_with_the_next_card_in_the_same_order(
        self, rig: Rig
    ) -> None:
        run = await chat_only_run(rig)
        other = await run.open_chat()
        card = await run.chat.card()
        await run.chat.answer(card, await run.chat.value_for(card["field"]))
        nxt = await run.chat.card()
        mirrored = await other.card(nxt["field"])
        assert mirrored["id"] == nxt["id"]

        def users(chat: Chat) -> list[Any]:
            return [m["text"] for m in chat.all if m["type"] == "message" and m["role"] == "user"]

        assert users(other) == users(run.chat)
        # The same card answered again from the other tab is the same answer (a repeat), not a second one.
        await other.send({"type": "inputResponse", "requestId": card["id"], "field": card["field"], "value": "other"})
        await asyncio.sleep(0.15)
        assert len(await list_field_candidates(rig.db.pool, run.id, card["field"])) == 1
        await run.step("after both tabs")
        await other.close()
        await run.chat.close()

    async def test_a_returning_call_its_first_turn_knows_what_was_collected_and_the_claim_still_completes(
        self, rig: Rig
    ) -> None:
        run = await rig.new_run()
        first = await voice_call_with_fields(run)
        await first.hang_up()
        rig.fresh()  # the second call has its own providers
        second = await run.start_call("Welcome back! Let's pick up where we left off.")
        content = str(rig.llm.requests[0].messages[-1].content)
        state = json.loads(content[len("STATE ") :])
        assert_matches(state, {"isReturningCall": True})
        assert "deviceModel" not in state["missing"]
        await second.hang_up()
        card = await run.chat.card("serialNumber")
        await run.chat.answer(card, "35-209900-176148-1")
        await run.chat.fill_rest()
        assert_matches((await confirm(run))["record"], {"outcome": "completed", "engagement": {"calls": 2}})
        await run.chat.close()


async def _status(run: Run, status: str) -> bool:
    return (await run.session()).status == status


async def _no_call(run: Run) -> bool:
    return (await run.session()).active_call_id is None


async def _has_candidate(rig: Rig, run: Run, field: str) -> bool:
    return len(await list_field_candidates(rig.db.pool, run.id, field)) > 0

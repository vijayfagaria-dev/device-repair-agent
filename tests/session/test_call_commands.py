"""The call's commands (P5-T02/T05/T06) against the throwaway test Postgres."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from app.db.repos.calls import list_calls
from app.db.repos.events import list_events
from app.db.repos.field_candidates import list_field_candidates
from app.db.repos.records import list_records
from app.db.repos.sessions import get_session
from app.db.repos.timers import Timer, list_timers, upsert_timer
from app.session.handlers.call import (
    AgentSays,
    AppendTranscript,
    EndCall,
    FlagForReview,
    OptOutByCall,
    SaveSpokenField,
    StartCall,
)
from tests.helpers.match import assert_matches
from tests.helpers.seed import seed_session
from tests.helpers.session import test_services


@pytest.fixture
async def services(db):  # type: ignore[no-untyped-def]
    return test_services(db)


async def run(services: Any, id_: str, command: object) -> Any:
    return (await services.processor.dispatch(id_, command)).reply


async def in_call(services: Any, id_: str, call_id: str | None = None) -> str:
    call_id = call_id or f"c{id_[:6]}"
    await run(services, id_, StartCall(call_id=call_id))
    return call_id


class TestStartEndCall:
    async def test_start_a_calls_row_active_call_id_call_started_no_call_start_cleared_user_activity_a_second_start_is_refused(
        self, db, services
    ) -> None:
        id_ = await seed_session(db.pool)
        await upsert_timer(
            db.pool, Timer(session_id=id_, kind="noCallStart", due_at=datetime.now(UTC) + timedelta(seconds=60))
        )
        assert await run(services, id_, StartCall(call_id="cA")) == {"status": "started", "returning": False}
        session = await get_session(db.pool, id_)
        assert session is not None and session.active_call_id == "cA"
        assert [c.id for c in await list_calls(db.pool, id_)] == ["cA"]
        assert [t.kind for t in await list_timers(db.pool, id_)] == ["sessionExpiry"]
        assert await run(services, id_, StartCall(call_id="cB")) == {"status": "refused", "reason": "active"}

    async def test_end_exactly_once_only_the_active_call_the_row_ended_with_its_reason_idle_re_armed_the_next_start_is_a_returning_call(
        self, db, services
    ) -> None:
        id_ = await seed_session(db.pool)
        call_id = await in_call(services, id_)
        assert_matches(await run(services, id_, EndCall(call_id=call_id, reason="hangup")), {"status": "ended"})
        assert await run(services, id_, EndCall(call_id=call_id, reason="network")) == {"status": "notActive"}
        assert [e.payload["reason"] for e in await list_events(db.pool, id_) if e.type == "call.ended"] == ["hangup"]
        assert_matches((await list_calls(db.pool, id_))[0], {"end_reason": "hangup"})
        assert sorted(t.kind for t in await list_timers(db.pool, id_)) == ["idle", "sessionExpiry"]
        assert await run(services, id_, StartCall(call_id="c2")) == {"status": "started", "returning": True}

    async def test_ends_the_user_did_not_choose_leave_a_reason_specific_chat_note_a_hang_up_leaves_it_to_the_planners_lead_in(
        self, db, services
    ) -> None:
        notes: dict[str, str | None] = {}
        for reason in [
            "hangup",
            "agent_ended",
            "network",
            "silence",
            "max_duration",
            "provider_error",
            "server_restart",
        ]:
            id_ = await seed_session(db.pool)
            call_id = await in_call(services, id_)
            await run(services, id_, EndCall(call_id=call_id, reason=reason))
            message = next((e for e in await list_events(db.pool, id_) if e.type == "chat.message"), None)
            notes[reason] = message.payload["message"]["text"] if message else None
        assert notes == {
            "hangup": None,
            "agent_ended": None,
            "network": "The call dropped. Let's continue here in chat.",
            "silence": "I didn't hear anything for a while, so I ended the call. Let's continue here in chat.",
            "max_duration": "We reached the time limit for a call. Let's finish here in chat.",
            "provider_error": "I'm having trouble with the voice line, so let's continue here in chat.",
            "server_restart": "The call was interrupted; let's continue here.",
        }

    async def test_a_closed_session_cannot_take_a_call(self, db, services) -> None:
        id_ = await seed_session(db.pool)
        await db.pool.execute("UPDATE sessions SET status = 'closed' WHERE id = $1", id_)
        assert await run(services, id_, StartCall(call_id="cX")) == {"status": "refused", "reason": "closed"}

    async def test_commands_given_as_dicts_with_snake_or_camel_keys_are_converted(self, db, services) -> None:
        id_ = await seed_session(db.pool)
        assert await run(services, id_, {"type": "StartCall", "callId": "cD"}) == {
            "status": "started",
            "returning": False,
        }
        assert_matches(
            await run(services, id_, {"type": "EndCall", "call_id": "cD", "reason": "hangup"}), {"status": "ended"}
        )


class TestAppendTranscript:
    async def test_stores_a_final_line_for_a_call_of_this_session_refuses_an_unknown_call_or_an_empty_line(
        self, db, services
    ) -> None:
        id_ = await seed_session(db.pool)
        call_id = await in_call(services, id_)

        def line(id__: str, call: str, text: str) -> AppendTranscript:
            return AppendTranscript(
                line={"id": id__, "call_id": call, "role": "user", "text": text, "started_at": datetime.now(UTC)}
            )

        assert await run(services, id_, line(f"tu_{call_id}_1", call_id, "Hello")) == {"appended": True}
        assert await run(services, id_, line("tu_nope_1", "nope", "Hi")) == {"appended": False}
        assert await run(services, id_, line(f"tu_{call_id}_2", call_id, "  ")) == {"appended": False}


class TestSaveSpokenField:
    """Code decides, never the model (D13, D14)."""

    @staticmethod
    async def save(services: Any, id_: str, field: str, value: str, evidence: str | None = None, **extra: Any) -> Any:
        return await run(
            services,
            id_,
            SaveSpokenField(field=field, value=value, evidence=value if evidence is None else evidence, **extra),
        )

    async def test_a_call_field_is_validated_and_stored_as_a_valid_call_candidate_with_the_evidence_kept_in_its_row_only(
        self, db, services
    ) -> None:
        id_ = await seed_session(db.pool)
        await in_call(services, id_)
        reply = await self.save(services, id_, "deviceModel", "Samsung Galaxy S23", "it's a Samsung Galaxy S23")
        assert reply == {"status": "valid", "normalized": {"brand": "Samsung", "model": "Galaxy S23"}}
        [candidate] = await list_field_candidates(db.pool, id_, "deviceModel")
        assert_matches(candidate, {"source": "call", "status": "valid", "evidence": "it's a Samsung Galaxy S23"})
        event = next(e for e in await list_events(db.pool, id_) if e.type == "field.candidate")
        assert "evidence" not in json.dumps(event.payload)

    async def test_an_identifier_heard_aloud_is_only_unverified_even_when_valid_an_invalid_one_is_invalid(
        self, db, services
    ) -> None:
        id_ = await seed_session(db.pool)
        await in_call(services, id_)
        assert await self.save(services, id_, "email", "asha@example.com", "asha at example dot com") == {
            "status": "unverified",
            "normalized": "asha@example.com",
        }
        assert_matches(await self.save(services, id_, "serialNumber", "1234"), {"status": "invalid"})
        assert [(c.field, c.status) for c in await list_field_candidates(db.pool, id_)] == [
            ("email", "unverified"),
            ("serialNumber", "invalid"),
        ]

    async def test_dates_come_from_the_customers_words_not_the_models_value(self, db, services) -> None:
        id_ = await seed_session(db.pool)
        await in_call(services, id_)
        assert_matches(
            await self.save(services, id_, "problemStartedAt", "2049-01-01", "tomorrow"), {"status": "invalid"}
        )
        yesterday = await self.save(services, id_, "problemStartedAt", "2049-01-01", "yesterday")
        assert_matches(yesterday, {"status": "valid", "normalized": {"precision": "day", "spoken": "yesterday"}})

    async def test_dont_know_for_the_model_is_asked_once_more_then_accepted_as_unknown_non_spoken_fields_and_finished_sessions_are_refused(
        self, db, services
    ) -> None:
        id_ = await seed_session(db.pool)
        await in_call(services, id_)
        assert_matches(await self.save(services, id_, "deviceModel", "I don't know"), {"status": "invalid"})
        assert await self.save(services, id_, "deviceModel", "I don't know") == {
            "status": "valid",
            "normalized": {"brand": None, "model": None},
        }
        assert await self.save(services, id_, "purchaseInvoice", "invoice.pdf") == {
            "status": "refused",
            "reason": "notSpoken",
        }
        await db.pool.execute("UPDATE sessions SET status = 'finalized', outcome = 'partial' WHERE id = $1", id_)
        assert await self.save(services, id_, "urgency", "high") == {"status": "refused", "reason": "notActive"}


class TestFlagForReviewAndOptOutByCall:
    async def test_a_safety_flag_is_r_1_anything_else_r_5_the_same_flag_twice_is_stored_once(
        self, db, services
    ) -> None:
        id_ = await seed_session(db.pool)
        assert await run(services, id_, FlagForReview(kind="safety", reason="battery is swelling")) == {
            "status": "flagged"
        }
        assert await run(services, id_, FlagForReview(kind="safety", reason="battery is swelling")) == {
            "status": "alreadyFlagged"
        }
        await run(services, id_, FlagForReview(kind="other", reason="customer disputes the warranty"))
        session = await get_session(db.pool, id_)
        assert session is not None
        assert session.review_flags == [
            {"rule": "R-1", "reason": "battery is swelling"},
            {"rule": "R-5", "reason": "customer disputes the warranty"},
        ]

    async def test_an_opt_out_on_the_call_produces_the_opted_out_record_revision_1_with_what_was_collected(
        self, db, services
    ) -> None:
        id_ = await seed_session(db.pool)
        await in_call(services, id_)
        await run(services, id_, SaveSpokenField(field="deviceType", value="laptop", evidence="a laptop"))
        assert await run(services, id_, OptOutByCall()) == {"status": "optedOut", "revision": 1}
        [record] = await list_records(db.pool, id_)
        assert_matches(
            record.payload,
            {
                "outcome": "optedOut",
                "revision": 1,
                "fields": {"deviceType": {"value": "laptop", "source": "call", "status": "valid"}},
                "engagement": {"calls": 1},
            },
        )
        assert "optout.confirmed" in [e.type for e in await list_events(db.pool, id_)]
        assert_matches(await run(services, id_, OptOutByCall()), {"status": "refused"})


class TestAgentSays:
    async def test_an_agent_line_goes_to_the_chat_and_an_empty_one_is_dropped(self, db, services) -> None:
        id_ = await seed_session(db.pool)
        assert await run(services, id_, AgentSays(text="  ")) == {"said": False}
        assert await run(services, id_, AgentSays(text=" Hello there ")) == {"said": True}
        [event] = await list_events(db.pool, id_)
        assert_matches(event.payload["message"], {"role": "agent", "text": "Hello there"})

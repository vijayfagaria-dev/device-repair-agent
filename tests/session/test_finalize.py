"""Finalization (P6-T01) against the throwaway test Postgres: each trigger yields a schema-valid record with the expected
outcome, in one transaction with the session update and the event; cost comes from the usage ledger and engagement from
calls, messages and attempts; a record that fails its schema becomes needsReview (R-5)."""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest

from app.db.repos.events import list_events
from app.db.repos.records import list_records
from app.db.repos.sessions import get_session
from app.db.repos.timers import Timer, list_timers, upsert_timer
from app.domain.fields import FIELDS, RECORD_FIELD_IDS
from app.domain.record import RecordProblem, RecordSchemaError, build_record, validate_record
from app.metrics.usage import record_usage
from app.protocol.enums import Outcome
from app.session.handlers.finalize import (
    FinalizeDeps,
    FinalizeOptions,
    finalize_effects,
    finalize_handler,
    finalize_prepare,
)
from app.session.hub import SessionUpdate
from app.session.snapshot import HistoryFacts, Snapshot
from tests.domain.helpers import FILE, VALID_VALUES
from tests.helpers.fake import FAKE_SECRET_VALUES
from tests.helpers.match import assert_matches
from tests.helpers.record_oracle import expect_sanitized_record
from tests.helpers.seed import seed_session
from tests.helpers.session import TEST_SIGNER, CapturedLog, end_seeded_call, seed_call, test_services

CHAT = {"serialNumber", "purchaseInvoice", "serviceCentre", "email", "additionalPhotos", "additionalNotes"}
REQUIRED = [f for f in RECORD_FIELD_IDS if FIELDS[f].required]


@pytest.fixture
async def services(db):  # type: ignore[no-untyped-def]
    return test_services(db)


def run(services: Any, id_: str, command: dict[str, Any]) -> Any:
    return services.processor.dispatch(id_, command)


async def collect(services: Any, id_: str, fields: list[str]) -> None:
    """A valid candidate for each field given, as the validators would have stored it."""
    for field in fields:
        await run(
            services,
            id_,
            {
                "type": "Test.Candidate",
                "field": field,
                "source": "chat" if field in CHAT else "call",
                "raw": "x",
                "normalized": VALID_VALUES[field],
                "status": "valid",
            },
        )


async def confirm_yes(services: Any, id_: str) -> None:
    """The user's Yes on "Submit claim?", as SubmitChatInput stores it."""
    await run(
        services,
        id_,
        {
            "type": "Test.Candidate",
            "field": "submitConfirmation",
            "source": "chat",
            "raw": True,
            "normalized": True,
            "status": "valid",
        },
    )


async def ready(services: Any, id_: str) -> None:
    """Every required field, then Yes."""
    await collect(services, id_, REQUIRED)
    await confirm_yes(services, id_)


class TestFinalizeTriggers:
    """One schema-valid record per trigger (the four outcomes)."""

    @pytest.mark.parametrize(
        ("name", "trigger", "outcome", "reason"),
        [
            ("completed", "confirmSubmit", Outcome.COMPLETED, r"user confirmed submission"),
            ("partial", "testFinalize", Outcome.PARTIAL, r"required fields missing: problemDescription"),
            ("optedOut", "optOutConfirmed", Outcome.OPTED_OUT, r"asked to stop"),
            ("needsReview", "confirmSubmit", Outcome.NEEDS_REVIEW, r"R-1 battery is swelling"),
        ],
    )
    async def test_trigger_to_outcome(
        self, db, services, name: str, trigger: str, outcome: Outcome, reason: str
    ) -> None:
        id_ = await seed_session(db.pool)
        if name == "completed":
            await ready(services, id_)
        elif name == "partial":
            await collect(services, id_, ["deviceType", "deviceModel"])
        elif name == "optedOut":
            await collect(services, id_, ["deviceType"])
        else:
            await ready(services, id_)
            await db.pool.execute(
                """UPDATE sessions SET review_flags = '[{"rule":"R-1","reason":"battery is swelling"}]' WHERE id = $1""",
                id_,
            )
        published: list[SessionUpdate] = []
        unsubscribe = services.hub.subscribe(id_, published.append)
        result = await run(services, id_, {"type": "Finalize", "trigger": trigger})
        unsubscribe()
        assert result.reply == {"finalized": True, "revision": 1, "outcome": outcome}

        [record] = await list_records(db.pool, id_)
        assert record.revision == 1
        validate_record(record.payload)
        expect_sanitized_record(record.payload, FAKE_SECRET_VALUES)
        assert_matches(record.payload, {"sessionId": id_, "revision": 1, "outcome": outcome, "previousRevision": None})
        assert re.search(reason, str(record.payload["outcomeReason"]))
        if trigger == "confirmSubmit":
            assert_matches(record.payload["submitConfirmation"], {"confirmed": True, "source": "chat"})
        else:
            assert record.payload["submitConfirmation"] is None

        session = await get_session(db.pool, id_)
        assert_matches(session, {"status": "finalized", "outcome": outcome, "current_revision": 1})
        events = await list_events(db.pool, id_)
        assert [e.payload for e in events if e.type == "session.finalized"] == [
            {
                "outcome": outcome,
                "revision": 1,
                "previousRevision": None,
                "trigger": trigger,
                "reason": record.payload["outcomeReason"],
                "contentHash": record.content_hash,
            }
        ]
        # The record travels on the update, never in an event payload (no signed URLs in the timeline).
        assert published[-1].record == {"revision": 1, "payload": record.payload}
        assert "sig=" not in json.dumps([e.payload for e in events])

    async def test_a_second_finalize_is_a_no_op_once_the_session_is_finalized_one_revision_nothing_written(
        self, db, services
    ) -> None:
        id_ = await seed_session(db.pool)
        await ready(services, id_)
        await run(services, id_, {"type": "Finalize", "trigger": "confirmSubmit"})
        before = await get_session(db.pool, id_)
        result = await run(services, id_, {"type": "Finalize", "trigger": "confirmSubmit"})
        assert result.reply == {"finalized": False, "reason": "session is finalized"}
        assert result.update is None
        assert len(await list_records(db.pool, id_)) == 1
        assert await get_session(db.pool, id_) == before

    async def test_confirm_submit_with_a_required_field_missing_writes_nothing_d16_not_possible(
        self, db, services
    ) -> None:
        id_ = await seed_session(db.pool)
        await collect(services, id_, ["deviceType"])
        await confirm_yes(services, id_)
        result = await run(services, id_, {"type": "Finalize", "trigger": "confirmSubmit"})
        assert result.reply["finalized"] is False
        assert re.match(r"^cannot confirm submission: required fields not valid", result.reply["reason"])
        assert result.update is None
        assert await list_records(db.pool, id_) == []

    async def test_confirm_submit_without_the_users_yes_writes_nothing_completed_always_carries_its_confirmation_pd2(
        self, db, services
    ) -> None:
        id_ = await seed_session(db.pool)
        await collect(services, id_, REQUIRED)
        result = await run(services, id_, {"type": "Finalize", "trigger": "confirmSubmit"})
        assert result.reply == {
            "finalized": False,
            "reason": "cannot confirm submission: the user hasn't tapped Yes on Submit claim?",
        }
        assert result.update is None

    async def test_cancels_the_sessions_outstanding_cards_and_clears_no_call_start_adds_the_closing_message(
        self, db, services
    ) -> None:
        id_ = await seed_session(db.pool)
        await upsert_timer(
            db.pool, Timer(session_id=id_, kind="noCallStart", due_at=datetime.now(UTC) + timedelta(seconds=60))
        )
        await run(services, id_, {"type": "Test.OpenCard", "request_id": "req_email_1", "field": "email"})
        result = await run(services, id_, {"type": "Finalize", "trigger": "optOutConfirmed"})
        update = result.update
        assert update is not None
        assert [(e.type, e.payload.get("requestId")) for e in update.events] == [
            ("input.cancelled", "req_email_1"),
            ("session.finalized", None),
            ("chat.message", None),
        ]
        assert_matches(
            update.events[-1].payload["message"],
            {"role": "agent", "text": "OK, I've stopped your claim. What you shared so far has been kept."},
        )
        assert "noCallStart" not in [t.kind for t in await list_timers(db.pool, id_)]
        assert update.session.open_request_id is None


class TestWhatTheRecordIsBuiltFrom:
    async def test_cost_is_the_usage_ledgers_list_price_equivalent_engagement_counts_calls_messages_answers_and_attempts(
        self, db, services
    ) -> None:
        id_ = await seed_session(db.pool)
        await record_usage(db.pool, session_id=id_, provider="deepgram", kind="nova-3:audio", units=120)
        call_id = f"c{id_[:8]}"
        await seed_call(db, id_, call_id, datetime.now(UTC) - timedelta(seconds=212))
        await end_seeded_call(db, call_id, datetime.now(UTC))
        await ready(services, id_)
        await run(services, id_, {"type": "Test.Say", "message_id": f"m1{id_[:6]}", "text": "hello"})
        await run(services, id_, {"type": "Test.OpenCard", "request_id": "req_email_1", "field": "email"})
        await run(services, id_, {"type": "Test.Reject", "request_id": "req_email_1"})
        await run(services, id_, {"type": "Finalize", "trigger": "confirmSubmit"})
        [record] = await list_records(db.pool, id_)
        expect_sanitized_record(record.payload, FAKE_SECRET_VALUES)
        assert record.payload["costUsd"] > 0
        assert_matches(
            record.payload["costBreakdownUsd"], {"stt": record.payload["costUsd"], "llm": 0, "tts": 0, "vision": 0}
        )
        assert record.payload["actualSpendUsd"] == 0
        assert record.payload["engagement"] == {
            "calls": 1,
            "callSeconds": 212,
            "chatMessages": 2,  # the test message and the closing message
            "chatInputsSubmitted": len([f for f in REQUIRED if f in CHAT]) + 1,  # + the Yes
            "invalidAttempts": 1,
        }

    async def test_files_become_signed_descriptors_the_url_is_the_servers_signed_link_for_the_file_id(
        self, db, services
    ) -> None:
        id_ = await seed_session(db.pool)
        await ready(services, id_)
        await run(services, id_, {"type": "Finalize", "trigger": "confirmSubmit"})
        [record] = await list_records(db.pool, id_)
        expect_sanitized_record(record.payload, FAKE_SECRET_VALUES)
        invoice = record.payload["fields"]["purchaseInvoice"]["value"]
        assert invoice["fileId"] == FILE["fileId"]
        url = urlsplit(invoice["url"])
        assert f"{url.scheme}://{url.netloc}{url.path}" == f"https://repair.example.com/files/{FILE['fileId']}"
        query = parse_qs(url.query)
        assert TEST_SIGNER.check(FILE["fileId"], query["exp"][0], query["sig"][0], datetime.now(UTC)) == "ok"

    async def test_a_record_that_fails_its_schema_is_rebuilt_as_needs_review_with_r_5_d17_and_the_session_keeps_the_flag(
        self, db
    ) -> None:
        local = test_services(db)
        id_ = await seed_session(db.pool)
        await ready(local, id_)
        problems = [RecordProblem(path="/fields/email/value", keyword="maxLength", message="too long")]
        first = True

        def build(input_: Any) -> Any:
            nonlocal first
            if first:
                first = False
                raise RecordSchemaError(problems)
            return build_record(input_)

        local.processor.register(
            "Test.FinalizeBroken",
            finalize_handler(FinalizeDeps(sign_file_url=TEST_SIGNER.sign, auto_complete_on_idle=True, build=build)),
            prepare=finalize_prepare,
        )
        result = await local.processor.dispatch(id_, {"type": "Test.FinalizeBroken", "trigger": "confirmSubmit"})
        # The timeline keeps where it broke (paths and keywords only).
        finalized = next(e for e in result.update.events if e.type == "session.finalized")
        expected_problems = [{"path": "/fields/email/value", "keyword": "maxLength", "message": "too long"}]
        assert finalized.payload["schemaProblems"] == expected_problems
        assert result.reply == {
            "finalized": True,
            "revision": 1,
            "outcome": Outcome.NEEDS_REVIEW,
            "schemaProblems": expected_problems,
        }
        [record] = await list_records(db.pool, id_)
        assert record.payload["reviewFlags"] == [{"rule": "R-5", "reason": "the record failed its schema"}]
        session = await get_session(db.pool, id_)
        assert session is not None and session.review_flags == [
            {"rule": "R-5", "reason": "the record failed its schema"}
        ]

    async def test_finalize_effects_refuses_to_run_without_the_cost_a_missing_prepare_step_is_a_bug_not_a_0_record(
        self, db
    ) -> None:
        id_ = await seed_session(db.pool)
        session = await get_session(db.pool, id_)
        assert session is not None
        snapshot = Snapshot(
            session=session,
            last_seq=1,
            history=HistoryFacts(),
            timers=[],
            requests=[],
            candidates=[],
            calls=[],
            now=datetime.now(UTC),
        )
        with pytest.raises(RuntimeError, match="needs the session cost"):
            finalize_effects(
                snapshot,
                FinalizeOptions(trigger="testFinalize"),
                FinalizeDeps(sign_file_url=TEST_SIGNER.sign, auto_complete_on_idle=True),
            )


class TestLogging:
    """P4 review #7, #8."""

    async def test_the_record_is_logged_without_its_signed_file_links(self, db) -> None:
        log = CapturedLog()
        local = test_services(db, log=log)
        id_ = await seed_session(db.pool)
        await ready(local, id_)
        await local.processor.dispatch(id_, {"type": "Finalize", "trigger": "confirmSubmit"})
        produced = next((kw for _lvl, msg, kw in log.lines if msg == "record produced"), None)
        assert produced is not None
        assert_matches(
            produced["record"],
            {"outcome": "completed", "fields": {"purchaseInvoice": {"value": {"fileId": FILE["fileId"]}}}},
        )
        assert "sig=" not in json.dumps(produced, default=str)
        assert log.errors() == []

    async def test_a_record_that_broke_its_schema_is_logged_as_an_error_with_the_paths_only(self, db) -> None:
        log = CapturedLog()
        local = test_services(db, log=log)
        first = True

        def build(input_: Any) -> Any:
            nonlocal first
            if first:
                first = False
                raise RecordSchemaError(
                    [RecordProblem(path="/fields/email/value", keyword="maxLength", message="too long")]
                )
            return build_record(input_)

        local.processor.register(
            "Test.FinalizeBroken2",
            finalize_handler(FinalizeDeps(sign_file_url=TEST_SIGNER.sign, auto_complete_on_idle=True, build=build)),
            prepare=finalize_prepare,
        )
        id_ = await seed_session(db.pool)
        await local.processor.dispatch(id_, {"type": "Test.FinalizeBroken2", "trigger": "testFinalize"})
        assert [(msg, kw["problems"]) for _lvl, msg, kw in log.errors()] == [
            (
                "record failed its schema; finalized as needsReview",
                [{"path": "/fields/email/value", "keyword": "maxLength", "message": "too long"}],
            )
        ]

"""The driver for full-session scenarios (P9-T01): one script drives the chat socket, the call socket and the fake
providers of a real server over a throwaway database, and an invariant checker runs after every step. The fakes drive the
provider seam only; nothing here says anything about the real providers (that is P9-T03).
(Port of server/test/scenarios/driver.ts.)"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from collections.abc import Callable
from typing import Any

import asyncpg

from app.db.pool import Database
from app.db.repos.events import list_events
from app.db.repos.outbox import list_outbox
from app.db.repos.records import StoredRecord, list_records
from app.db.repos.sessions import Session, get_session
from app.domain.record import validate_record
from app.protocol.schemas import parse_chat_server_message
from app.session.services import SessionServices
from app.voice.call_engine import CallTimings
from app.voice.fakes.llm import FakeLlm, LlmScript
from app.voice.fakes.stt import FakeStt
from app.voice.fakes.tts import FakeTts
from app.ws.call import Providers, VoiceDeps
from tests.helpers.app import RunningApp, TestSocket, connect, start_app, wait_for
from tests.helpers.chat_flow import ANSWERS, PDF
from tests.helpers.db import TestSchema, create_migrated_schema
from tests.helpers.fake import FAKE_SECRET_VALUES
from tests.helpers.record_oracle import expect_sanitized_record
from tests.helpers.session import TEST_FILE_URL_SECRET, test_services

Msg = dict[str, Any]


async def wait(check: Callable[[], Any], what: str, within: float = 4.0) -> None:
    await wait_for(check, what, within, 0.008)


# ---------------------------------------------------------------------------------------------------------------------
# Invariants: what must hold after every step, whatever the scenario.

#: Statement-level append-only triggers fire even when no row matches, so this changes nothing.
IMMUTABLE = ["events", "field_candidates", "records"]


async def check_invariants(db: Database, session_id: str) -> None:
    # One snapshot for every read: a command committing between two queries must not look like a broken invariant.
    async with db.pool.acquire() as conn, conn.transaction(isolation="repeatable_read", readonly=True):
        await _check_snapshot(conn, session_id)
    await _check_append_only(db)


async def _check_snapshot(db: Any, session_id: str) -> None:
    session = await get_session(db, session_id)
    assert session is not None, "the session exists"
    # At most one open card, and the session points at it.
    open_ids = [
        r["id"]
        for r in await db.fetch("SELECT id FROM input_requests WHERE session_id = $1 AND status = 'open'", session_id)
    ]
    assert len(open_ids) <= 1, "at most one open card"
    assert session.open_request_id == (open_ids[0] if open_ids else None), "open_request_id matches the open card"
    # At most one running call, and the session points at it.
    running = [
        r["id"] for r in await db.fetch("SELECT id FROM calls WHERE session_id = $1 AND ended_at IS NULL", session_id)
    ]
    assert len(running) <= 1, "at most one running call"
    assert session.active_call_id == (running[0] if running else None), "active_call_id matches the running call"
    # Events are contiguous from 1: nothing lost, nothing reordered.
    seqs = [e.seq for e in await list_events(db, session_id)]
    assert seqs == list(range(1, len(seqs) + 1)), "event seq contiguous"
    # Records: contiguous revisions, schema-valid and sanitized, one outbox row each, the session agrees.
    records = await list_records(db, session_id)
    assert [r.revision for r in records] == list(range(1, len(records) + 1)), "revisions contiguous"
    for record in records:
        validate_record(record.payload)
        expect_sanitized_record(record.payload, FAKE_SECRET_VALUES)
        assert record.payload["revision"] == record.revision
        assert record.payload["sessionId"] == session_id
    assert session.current_revision == len(records), "current_revision is the latest revision"
    assert [o.revision for o in await list_outbox(db, session_id)] == [r.revision for r in records], (
        "one outbox row per revision"
    )
    if session.status == "finalized":
        assert session.outcome is not None, "a finalized session has an outcome"


async def _check_append_only(db: Database) -> None:
    # History cannot be rewritten.
    for table in IMMUTABLE:
        try:
            await db.pool.execute(f"UPDATE {table} SET session_id = session_id WHERE false")
        except asyncpg.PostgresError:
            continue
        raise AssertionError(f"{table} is append-only")


def expect_valid_protocol(messages: list[Msg]) -> None:
    for message in messages:
        try:
            parse_chat_server_message(message)
        except Exception as err:
            raise AssertionError(f"invalid protocol message {json.dumps(message)}: {err}") from err


# ---------------------------------------------------------------------------------------------------------------------


class Chat:
    def __init__(self, run: Run, url: str) -> None:
        self.run = run
        self.socket: TestSocket = connect(url)
        self._read = 0

    @property
    def all(self) -> list[Msg]:
        return self.socket.messages

    async def ready(self) -> Chat:
        await self.socket.opened
        await wait(lambda: any(m["type"] == "syncDone" for m in self.all), "syncDone")
        return self

    async def until(self, test: Callable[[Msg], bool], within: float = 4.0) -> Msg:
        """The next message after the ones consumed that matches."""
        deadline = time.monotonic() + within
        while True:
            for index in range(self._read, len(self.all)):
                if test(self.all[index]):
                    self._read = index + 1
                    return self.all[index]
            if time.monotonic() > deadline:
                raise AssertionError(f"timed out; last messages: {json.dumps(self.all[-4:])}")
            await asyncio.sleep(0.008)

    def skip_to_end(self) -> None:
        """Marks everything so far as read (what a reload shows is checked from a fresh socket)."""
        self._read = len(self.all)

    async def card(self, field: str | None = None) -> Msg:
        return await self.until(lambda m: m["type"] == "inputRequest" and (field is None or m.get("field") == field))

    async def send(self, message: Msg) -> None:
        await self.socket.send(json.dumps(message))

    async def answer(self, card: Msg, value: Any) -> None:
        await self.run.step(f"before answering {card.get('field')}")
        await self.send({"type": "inputResponse", "requestId": card["id"], "field": card["field"], "value": value})

    async def upload(self, data: bytes = PDF, name: str = "invoice.pdf", content_type: str = "application/pdf") -> str:
        async with self.run.rig.server.client() as client:
            response = await client.post(f"/sessions/{self.run.id}/files", files={"file": (name, data, content_type)})
        assert response.status_code == 200
        return str(response.json()["url"])

    async def value_for(self, field: str) -> Any:
        return await self.upload() if field == "purchaseInvoice" else ANSWERS.get(field)

    async def give(self, field: str, value: Any = ...) -> Msg:
        """Answers the next card, which must be for `field`, with a valid value (a file card gets an uploaded PDF)."""
        card = await self.card()
        assert card["field"] == field
        await self.answer(card, await self.value_for(field) if value is ... else value)
        return card

    async def fill_rest(self) -> None:
        """Chat-flow answers up to (not including) Submit claim?, from the next card on."""
        for _ in range(12):
            card = await self.card()
            if card["field"] == "submitConfirmation":
                # Put it back: the caller answers it.
                self._read = next(i for i, m in enumerate(self.all) if m is card)
                return
            await self.answer(card, await self.value_for(card["field"]))
        raise AssertionError("never reached Submit claim?")

    async def close(self) -> None:
        await self.socket.close()


class Call:
    def __init__(self, run: Run, socket: TestSocket) -> None:
        self.run = run
        self.socket = socket

    @property
    def stt(self) -> FakeStt:
        return self.run.rig.stt

    async def say(self, text: str, *scripts: LlmScript) -> None:
        """The customer speaks; the model's next turns are scripted (a tool-call turn and then the follow-up speech)."""
        llm = self.run.rig.llm
        llm.enqueue(*scripts)
        self.stt.current.say(text)
        await wait(lambda: llm.queued == 0, "the scripted turns to be taken")
        await asyncio.sleep(0.06)  # the turn's effects commit and the follow-up plays
        await self.run.step(f'after saying "{text[:30]}"')

    async def hang_up(self) -> None:
        await self.socket.close(1000)
        await wait(lambda: _call_ended(self.run), "the call to end")
        await self.run.step("after hang-up")


async def _call_ended(run: Run) -> bool:
    session = await get_session(run.rig.db.pool, run.id)
    return session is not None and session.active_call_id is None


class Run:
    chat: Chat

    def __init__(self, rig: Rig, id_: str) -> None:
        self.rig = rig
        self.id = id_

    async def step(self, label: str) -> None:
        try:
            await check_invariants(self.rig.db, self.id)
        except AssertionError as err:
            raise AssertionError(f"invariant broken {label}: {err}") from err

    async def start_call(
        self, greeting: str = "Hi, I'm Riya from device repairs. What's wrong with your device?"
    ) -> Call:
        """Starts a call; the model's greeting is scripted. Returns once the providers are open."""
        rig = self.rig
        rig.llm.enqueue(LlmScript(text=greeting))
        socket = connect(f"{rig.server.ws}/call?sessionId={self.id}")
        await socket.opened
        await wait(lambda: len(rig.stt.streams) > 0, "the providers to open")
        await wait(lambda: _call_started(self), "the call to start")
        await wait(lambda: rig.llm.queued == 0, "the greeting")
        await asyncio.sleep(0.06)
        await self.step("after the call started")
        return Call(self, socket)

    async def session(self) -> Session:
        session = await get_session(self.rig.db.pool, self.id)
        if session is None:
            raise AssertionError("the session does not exist")
        return session

    async def records(self) -> list[StoredRecord]:
        return await list_records(self.rig.db.pool, self.id)

    async def open_chat(self) -> Chat:
        """A reload or a second tab: a fresh chat socket on the same session."""
        return await Chat(self, f"{self.rig.server.ws}/chat?sessionId={self.id}").ready()


async def _call_started(run: Run) -> bool:
    session = await get_session(run.rig.db.pool, run.id)
    return session is not None and session.active_call_id is not None


class Rig:
    def __init__(self, schema: TestSchema, services: SessionServices) -> None:
        self.schema = schema
        self.db = schema.db
        self.services = services
        self.stt = FakeStt()
        self.tts = FakeTts()
        self.llm = FakeLlm()
        self.server: RunningApp

    @staticmethod
    async def create(base_url: str, name: str = "fullsessions") -> Rig:
        schema = await create_migrated_schema(base_url, name, max_size=12)
        rig = Rig(schema, test_services(schema.db, planner=True))
        rig.server = await start_app(
            schema.db,
            services=rig.services,
            file_url_secret=TEST_FILE_URL_SECRET,
            uploads_per_minute=1000,
            voice=VoiceDeps(
                providers=lambda: Providers(rig.stt, rig.tts, rig.llm),
                max_concurrent_calls=4,
                timings=CallTimings(silence_ms=60_000),
            ),
        )
        rig.llm.fallback = LlmScript(text="Okay.")
        return rig

    def fresh(self) -> None:
        """New fakes for the next scenario (the server, database and sockets stay)."""
        self.stt = FakeStt()
        self.tts = FakeTts()
        self.llm = FakeLlm()
        self.llm.fallback = LlmScript(text="Okay.")

    async def new_run(self) -> Run:
        """A new session, created by its chat socket as the browser does."""
        self.fresh()
        run = Run(self, str(uuid.uuid4()))
        run.chat = await Chat(run, f"{self.server.ws}/chat?sessionId={run.id}").ready()
        return run

    async def close(self) -> None:
        await self.server.close()
        await self.schema.drop()


def save(field: str, value: str, evidence: str, user_confirmed: bool = False) -> dict[str, Any]:
    """The tool call the model makes for one spoken field."""
    args: dict[str, Any] = {"field": field, "value": value, "spoken_evidence": evidence}
    if user_confirmed:
        args["user_confirmed"] = True
    return {"name": "save_field", "args": args}


def five_voice_fields() -> list[dict[str, Any]]:
    """One turn in which the model saves all five voice fields (acknowledge-then-ask: the follow-up is its own script)."""
    return [
        save("deviceType", "smartphone", "it's my phone"),
        save("deviceModel", "Apple iPhone 14 Pro", "an iPhone 14 Pro"),
        save(
            "problemDescription",
            "Screen flickers and goes black after a drop",
            "the screen flickers and goes black after I dropped it",
        ),
        save("problemStartedAt", "last Tuesday", "it started last Tuesday"),
        save("urgency", "high", "I need it for work tomorrow"),
    ]


FIVE_VOICE_WORDS = (
    "It's my phone, an iPhone 14 Pro. The screen flickers and goes black after I dropped it. "
    "It started last Tuesday and I need it for work tomorrow."
)

# Device Repair Claim Agent

> Ported to Python (FastAPI) from an earlier TypeScript prototype.

[![CI](https://github.com/vijayfagaria-dev/device-repair-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/vijayfagaria-dev/device-repair-agent/actions/workflows/ci.yml)

A customer reports a faulty device by **voice call** to an agent named Riya. Anything awkward to say aloud (serial number, invoice, email) arrives as a **card in the chat** on the same page while the call continues. If the call drops, the chat carries on from the same state. Every session ends in **one validated, versioned JSON record**, delivered to a webhook exactly once in effect.

**Live demo:** https://device-repair-agent.onrender.com/
*(Free hosting sleeps when idle: the first load can take about a minute. Use made-up data only.)*

## How it works

```
Browser (React) ──WS /call  mic audio in, agent audio + transcript out
                └─WS /chat  cards, messages, final record
        │
Server (Python 3.13, FastAPI + uvicorn, one process)
  Call engine:  speech-to-text → LLM with tools → text-to-speech
  Command processor: every change is one transaction → append-only events → publish
  Record builder + outcome rules · Delivery outbox · Persisted timers
        │
Postgres (Neon): sessions, events, field candidates, files, records, outbox
Providers: Deepgram (STT, TTS) · Groq gpt-oss-20b (LLM) · Gemini (fallback)
```

- **One session, two views.** The call and the chat are two sockets onto the same session; each change is a database transaction that both channels see. A reload, a second tab or a server restart shows the same conversation.
- **Values are candidates.** Each answer from the call or a card is stored as a candidate; the effective field and any conflict are computed from them, so the channels cannot drift apart.
- **One record per session.** Rules turn the candidates into `completed`, `partial`, `optedOut` or `needsReview`; a record is stored and queued for delivery in one transaction, so a crash never produces it twice.

More detail: [architecture](docs/architecture.md) · [record and outcomes](docs/record.md) · [API](docs/api.md) · [security](docs/security.md) · [cost and latency](docs/performance.md) · [edge cases](docs/reliability.md).

## Technical decisions

| Decision | Reason |
|---|---|
| Own speech-to-text → LLM → text-to-speech pipeline on the server | Full control of interruption (barge-in) and transcript truncation; no provider key ever reaches the browser |
| Identifiers (serial number, email) must be typed in the chat | Speech recognition is unreliable for alphanumerics; a spoken value is kept as `unverified` |
| Completion needs an explicit "Submit claim?" tap | A misheard "yes" cannot submit a claim |
| Dates like "last Tuesday" are resolved in code, not by the model | Models get date arithmetic wrong; the resolver is tested |
| A value is saved only if the customer's own words back it | The small free-tier model invented values in early calls; saves are checked against what was actually said |
| Postgres for everything (state, files, timers, delivery outbox) | One store to restore after a restart; nothing is lost |
| Free tiers only (Render, Neon, Deepgram, Groq) | Real spend is $0; cost per session is reported as a list-price equivalent |

## Run it locally

Needs Python 3.13 with [uv](https://docs.astral.sh/uv/), Node 22 (only to build the UI) and a Postgres database (a free Neon one works).

```bash
uv sync
cp .env.example .env     # set DATABASE_URL, PUBLIC_ORIGIN, FILE_URL_SECRET, HOOK_SECRET,
                         # and DEEPGRAM_API_KEY + GROQ_API_KEY for voice
npm ci && npm run build -w web
set -a; . ./.env; set +a
uv run python -m app     # http://localhost:8080, migrations run at start
```

Without provider keys the chat, cards, records and API still work; only calls are refused. Tests (over 1,100, on a throwaway Postgres 18, started automatically if installed locally or via `TEST_DATABASE_URL`): `uv run pytest tests`; lint and types: `uv run ruff check app tests && uv run mypy app`; UI tests: `npm test`. Deployment is a Render Blueprint (`render.yaml`, Docker) that deploys only after CI passes.

## Known limitations

- **No "which value is correct?" card** when the call and the chat disagree on an identifier; it goes to review instead.
- **English only**; no Hindi or other Indian languages yet.
- **One call at a time** (free-tier LLM rate limit), and the free server sleeps when idle, so a first call after a quiet period can start slowly.
- **A restart ends a live call**; the customer taps Call again and it resumes from the saved state.
- **No browser end-to-end tests** after the move to Python: the old Playwright specs scripted the TypeScript server's fakes in-process and were dropped. The API, both sockets and a real server process are covered by the Python tests.
- **Model behaviour is the least-tested part**: tool handling and guards are tested with scripted models, but what the real model says is only checked by hand.
- **Cost and latency numbers are not yet measured** on the deployed system ([how they will be](docs/performance.md)).

## Built with AI

Claude Code wrote most of the code and tests under my direction. It was fast at the many small exact pieces (validators, state machines, test scaffolding) and at reviewing its own work. It misled me by treating "audio sent" as "audio heard", by writing prompt rules the model then ignored, and by over-constraining the agent's speech until it sounded scripted; each was caught by tests or live calls and fixed.

# HANDOFF: resume the Python port here

Paused on purpose (usage limit). Read this file, then `E2-PROGRESS.md`, then continue. Delete both when done.

## Goal
The assignment requires **Python (FastAPI or Django)**. The working app is a TypeScript prototype (`server/`). We are
porting it to Python/FastAPI, keeping the React UI (`web/`), the WebSocket protocol, `shared/record.schema.json`, the SQL
migrations and the REST API byte-compatible. The user got a deadline extension.

Repo: `/Users/tamio/Documents/Assignment/hunar-voice-chat-agent/submission` (git remote `vijayfagaria-dev/device-repair-agent`,
branch `main`). Deployed (TypeScript) at https://device-repair-agent.onrender.com. Today the TS server in `server/` is the
**reference**: read it, do not edit it. The porting rules are in `PORTING.md` (naming, wire compat, db layer).

## Decisions the user made (do not re-ask)
- **Final deliverable = a NEW public repo `voice-chat-agent`** under `vijayfagaria-dev` with ONE neutral commit
  `Initial commit` and a one-line README note: *"Ported to Python (FastAPI) from an earlier TypeScript prototype."*
  Name is free (checked). Create it only after verification and after asking the user for a final go-ahead; run
  `gitleaks` (or the repo's `scripts/plant-and-detect.sh` approach) on the exported tree first.
- **Old repo keeps its history.** Do NOT rewrite or force-push it unless the user explicitly says "wipe it".
  I refused to fake a history that looks Python-from-the-start; the one-line README note is the agreed honest way.
- Both repos should end with the **same file tree** (cutover commit in the old repo, then export that tree to the new one).
  The user will repoint Render themselves (dashboard). Keep the Render service name `device-repair-agent`.
- README must be **short**: setup, architecture, technical decisions, known limitations, deployed URL (details in `docs/`).
  It must be rewritten for Python (the current README still describes Node).
- **No `Co-Authored-By` trailers** in commits. Commit/push as normal commits; no force-push without explicit ask.
- Riya's speech stays the model's own (natural persona, introduces herself). Fix root causes, not wrapper filters.

## Status of the Python port (all verified by running the tests)
| Part | Where | State |
|---|---|---|
| DB core (asyncpg pool, tx, migrations, test fixtures) | `app/db/`, `tests/conftest.py`, `tests/helpers/db.py` | committed, 8+17 tests |
| Repos, file signing/storage, metrics | `app/db/repos/ app/files/ app/metrics/` | committed, 94 tests |
| Protocol + domain (validators, record builder) | `app/protocol/ app/domain/` | committed, 455 tests, 99% branch cov |
| Agent + voice engine (LLM router, call engine, Deepgram) | `app/agent/ app/voice/` | committed, 160 tests |
| Session layer (processor, handlers, hub) | `app/session/` | committed, 81 + 22 scenario tests |
| Config, logging, quota guard, delivery worker, HTTP API | `app/config.py app/logging.py app/limits app/delivery app/api` | committed, 171 tests |
| **WebSocket layer, sweeper, boot, main** | `app/ws app/jobs app/boot app/main.py app/__main__.py` | committed; 1049 tests pass, ruff + mypy clean; **verified 2026-11-12**: `python -m app` boots, migrates, serves; `scripts/check-api-examples.sh` 32/0; WS /chat handshake OK |

Last pushed commit when paused: `89a1f5d` (everything is committed and pushed). `Dockerfile` has never been built (no Docker
daemon access locally): CI must build it.

## Next steps, in order
DONE: step 2 (verify) except the deferred tests below. Remaining before cutover: step 1 deferred tests (test_shutdown DONE 6 tests; boot process, chaos, smoke, scenarios, the skipped reconcile case), step 3 (UI smoke with real keys).
1. Read `E2-PROGRESS.md`; finish the WebSocket layer + sweeper + boot + `app/main.py` + `python -m app`; port the deferred
   tests (list in that file). Tip: spawn ONE agent per unfinished piece, with a tight brief pointing at `PORTING.md`.
2. Verify: `uv run pytest tests -q` (starts a temp Postgres 18 automatically), `uv run ruff check app tests`, `uv run mypy app`.
   Then start the server (`uv run python -m app`, env from `tests/helpers/env.py valid_env`) and run
   `scripts/check-api-examples.sh http://127.0.0.1:8080`: all checks, including WS /chat and WS /call, must pass.
3. Smoke-test the real UI against the Python server (`npm run build -w web`, open the page, call + chat).
4. Cutover commit in the old repo: delete `server/`, `e2e/`, `playwright.config.ts`, `vitest.config.ts` server parts, `PORTING.md`,
   `HANDOFF.md`, `E2-PROGRESS.md`, `.handoff/`; set root `package.json` workspaces to `["shared","web"]` (web tests need
   `vitest`); replace `render.yaml` with `.handoff/render.yaml.new` (docker runtime); replace `.github/workflows/ci.yml`
   with: ruff + mypy + pytest (Postgres 18 service, domain coverage ≥ 90%) + web build + `scripts/check-bundle-secrets.sh web/dist`
   + `docker build` + the existing gitleaks/plant-and-detect job. Playwright e2e specs cannot be ported (they script the TS
   server's fakes in-process): drop them and list it under known limitations.
5. Rewrite `README.md` (short, Python setup via `uv`, env vars, architecture, decisions, limitations, the one-line port note)
   and move `docs/*` text that still says Node/Fastify to Python.
6. Export the tree to the new repo: `git init` in a temp dir, copy tracked files, one commit `Initial commit`, secret scan,
   then (after user's go-ahead) `gh repo create voice-chat-agent --public` and push.
7. Measure cost/latency on the deployed system (10 real sessions) and fill the README's PENDING numbers
   (`uv run python scripts/report.py` has to be ported from `server/scripts/report.ts` first; not done yet).

## Useful facts
- Python 3.13, `uv`, asyncpg (SQL keeps `$1`), pydantic v2, structlog, pytest-asyncio (`asyncio_mode=auto`), ruff.
- Local Postgres 18 from Homebrew is used by the tests; `TEST_DATABASE_URL` overrides. The live Neon DB URL is in `server/.env`
  (git-ignored). The live DB was wiped of session data on 2026-11-11 (authorised); 10 fresh sessions still have to be recorded.
- TS fixes from live calls are already ported (grounded saves, stale-text drop, broken-stream retry, speech filter, one live call per
  claim = close 4409 not 4429). The Python call route must keep the `sessions_in_call` check before the capacity check.
- Agents report in the transcript only; the per-module public names are documented in the module docstrings/signatures.

# E2 progress note

## (a) Files created (all new; nothing else changed)
app/ws/: socket.py, closing.py, keep_alive.py, handshake.py, chat_projection.py, chat_replay.py, chat.py, call.py, plugin.py, protocol.py
app/jobs/sweeper.py
app/boot/: recover.py, shutdown.py
app/main.py (build_app, create_app, AppServer, server_config, run, lazy `app`), app/__main__.py
tests/helpers/: app.py (start_app, start_full_app, TestSocket, RawSocket, wait_for), hooked_pool.py
tests/ws/: test_chat.py (15), test_call.py (18), test_chat_projection.py (6), test_chat_replay.py (13), test_chat_record.py (5)
tests/jobs/test_sweeper.py (14), tests/boot/test_recover.py (2)
(empty __init__.py in tests/ws, jobs, boot, chaos, smoke)

## (b) Status
DONE and passing: app/ws (chat+call), app/jobs/sweeper, app/boot/recover+shutdown code, app/main.py, app/__main__.py
(main.py not yet exercised by a full create_app test or the process run), tests above = 73 passing.
NOT STARTED: tests/boot/test_shutdown.py, tests/boot (boot.test.ts process tests), tests/chaos (failpoints + restart),
tests/smoke, tests/scenarios (chat_only, full_sessions, driver), WS cases of limits/quota_guard/security controls,
tests/session/test_reconcile.py skipped case, test_health leftovers, eval (skipped, not looked at),
scripts/check-api-examples.sh run.

## (c) Next steps
- test_shutdown.py: port shutdown.test.ts using ShutdownDeps (close_server, settle_calls, stop_sweeper, drain_commands,
  stop_outbox, close_pool, timeout_ms, exit); real-pieces test = start_app + running.close() as close_server.
- create_app smoke: tests.helpers.app.start_full_app(load_config(valid_env(...)), db=db, providers=Providers(...)).
- process tests: spawn `python -m app` (env from tests/helpers/env.valid_env, HOST/PORT=0); startup log line is JSON
  msg "server listening" with address. Chaos needs NODE_ENV=test + FAILPOINTS. Smoke: node can run the TS
  deployed-smoke.ts unchanged (node 22.22).
- scenarios: port driver.ts into tests/scenarios/driver.py on start_app + FakeStt/Tts/Llm (see tests/ws/test_call.py Voice rig).
- finally run scripts/check-api-examples.sh against `uv run python -m app`.

## (d) Failing tests
None known among the 73. Only run per-file; full suite not run. test_call has a timing race fixed with call_slots_free().

## (e) Edits to other agents' modules
None. (I ran `ruff format app tests` once repo-wide early; it may have reformatted other files.)

## Deviations to report
- Keepalive via uvicorn ws_ping_interval/timeout (global, /call values: 5s x2), custom protocol class app.ws.protocol
  reports 1006 for abnormal closes; server config must use main.server_config (proxy_headers=False, ws option).
- Shutdown: AppServer.shutdown sends closing+1012 to all sockets first; uvicorn reports our close at once, so the 2s
  grace is not waited out (test asserts only the upper bound).
- Outbox default target is the in-process stub receiver via httpx ASGITransport (no TCP).

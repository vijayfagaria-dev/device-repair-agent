# API reference

[`shared/record.schema.json`](shared/record.schema.json) is the canonical schema of the record (draft 2020-12). The server validates every record against it before it is stored, and the receiving stub validates again before accepting a delivery.


The page talks to the server over the two WebSockets and one upload endpoint. The rest is for inspecting sessions and for tests. A session id is a UUIDv4; knowing it is the permission to read the session, so these routes need no token (they are rate-limited per IP). Errors are JSON. Replace `$BASE` with `http://localhost:8080` or the public URL, `https://device-repair-agent.onrender.com`. [`scripts/check-api-examples.sh`](scripts/check-api-examples.sh) runs every example below and fails if a status or a body differs from this table, or if this page stops documenting one of the endpoints.

| Endpoint | Auth | Success | Notes and errors |
|---|---|---|---|
| `GET /healthz` | none | 200 `{"status":"ok"}` | No database access (the uptime monitor and Render poll it). |
| `GET /readyz` | none | 200 `{"status":"ok"}` | Checks the database; 503 when it is unreachable. For manual checks, never polled. |
| `POST /sessions/:sessionId/files` | none | 200 `{"url":"file:<id>"}` | `multipart/form-data`, one part named `file`. Creates the session if the id is a new UUIDv4. 400 bad request, 413 too large, 415 unsupported type, 429 rate limited, 507 upload budget reached. The `url` is an opaque reference to pass back in an answer, not a download link. |
| `GET /api/sessions/:id` | none | 200 session summary | The effective value and status of every field, the open card, status, outcome and revision. 400 not a UUIDv4, 404 unknown (reading never creates a session). |
| `GET /api/sessions/:id/timeline` | none | 200 | Events in order, transcript, per-turn timings, usage ledger, cost (list-price equivalent and actual $0) and delivery attempts. |
| `GET /api/sessions/:id/records` | none | 200 `{"sessionId", "records":[…]}` | Every revision, oldest first (empty until the session is finalized). |
| `GET /files/:fileId?exp=&sig=` | signed link | 200 file | Only the links inside a record work. 403 bad signature, 410 expired, 404 unknown. |
| `POST /hooks/records` | `X-Hook-Secret` | 200 `{"stored":true,"timesReceived":n}` | The stub receiver the outbox delivers to. Needs `Idempotency-Key: <sessionId>:<revision>` matching the body; 400 invalid record or key, 401 no or wrong secret. A duplicate returns 200 with `timesReceived` > 1 and stores nothing new. |
| `GET /hooks/records` | `Authorization: Bearer <TEST_API_TOKEN>` | 200 `{"records":[…]}` | What the stub received. Registered only when the test API is enabled; 401 otherwise. |
| `POST /api/sessions` | `Authorization: Bearer <TEST_API_TOKEN>` | 201 `{"sessionId"}` | Test API, registered only when `ALLOW_TEST_API=true`: **401 without a token where it is on, 404 where it is off (the public deployment)**. |
| `POST /api/sessions/:id/finalize` | `Authorization: Bearer <TEST_API_TOKEN>` | 200 | Test API only: finalizes with the `testFinalize` trigger. |
| `WS /chat?sessionId=<id>` | Origin | messages | Cards, messages, transcript lines, the record, `sessionState`. Replays history on connect. |
| `WS /call?sessionId=<id>` | Origin | audio | Binary PCM16 mic frames (640 bytes each) in; JSON audio and transcript messages out. |

Examples (the statuses are what the script checks):

```bash
BASE=http://localhost:8080
ID=$(uuidgen | tr 'A-Z' 'a-z')            # any UUIDv4 you generate is a new session

curl -s $BASE/healthz                                              # 200 {"status":"ok"}
curl -s $BASE/readyz                                               # 200 {"status":"ok"}

# Upload a file: this also creates the session
curl -s -X POST -F file=@invoice.png $BASE/sessions/$ID/files      # 200 {"url":"file:…"}
curl -s -X POST -F file=@notes.txt   $BASE/sessions/$ID/files      # 415 {"error":{"code":"unsupported_type",…}}

# Inspect the session
curl -s $BASE/api/sessions/$ID                                     # 200 {"sessionId":…,"status":"active",…}
curl -s $BASE/api/sessions/$ID/timeline                            # 200 {"events":[{"type":"session.created",…}],…}
curl -s $BASE/api/sessions/$ID/records                             # 200 {"sessionId":…,"records":[]}
curl -s $BASE/api/sessions/$(uuidgen | tr 'A-Z' 'a-z')             # 404 {"error":"not_found",…}
curl -s $BASE/api/sessions/not-a-uuid                              # 400 {"error":"invalid_session_id",…}

# Signed links and the receiver refuse unsigned or unauthenticated requests
curl -s "$BASE/files/f7ZIrgocLlJQS_L26?exp=1&sig=x"                # 403 {"error":{"code":"forbidden",…}}
curl -s -X POST -H 'Content-Type: application/json' -d '{}' $BASE/hooks/records   # 401 {"error":"unauthorized"}

# Test API (only where ALLOW_TEST_API=true; 404 on the public deployment)
curl -s -X POST $BASE/api/sessions                                 # 401 (or 404 where it is off)
curl -s -X POST -H "Authorization: Bearer $TEST_API_TOKEN" $BASE/api/sessions    # 201 {"sessionId":…}
curl -s -H "Authorization: Bearer $TEST_API_TOKEN" $BASE/hooks/records           # 200 {"records":[…]}
```

A WebSocket from any Origin other than the site's own is answered with a `closing` message (close code 4403), which `curl` shows after the 101 upgrade. The wire messages, close codes and limits of both sockets are typed in `shared/protocol/` (zod schemas in `schemas.ts`).

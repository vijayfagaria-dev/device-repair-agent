# Device repair claim: a voice + chat agent

A user reports a faulty device. The conversation starts on a **web voice call**; the agent collects what is easy to say by talking and sends **chat cards** (a serial number, an invoice, a service centre, an email) in the same page while the call goes on. If the call drops, the chat carries on from the same state. Every session ends with **one sanitized, versioned JSON record**, stored and delivered to a webhook exactly once in effect.

> **Status of this README.** Everything below describes the code in this repository and is checked against it. One thing is **not available yet** and is marked `PENDING` where it matters: the measured cost and latency numbers (they must come from real sessions on the deployed system). Nothing in this README is an estimate presented as a measurement.

| | |
|---|---|
| **Public URL** | **https://device-repair-agent.onrender.com/** (Render free web service, Virginia). It sleeps after 15 minutes without traffic, so the first request after a quiet period can take about a minute. |
| **Try it** | Open the URL, tap **Call**, allow the microphone, and say what is wrong with a device. Cards appear in the thread as the agent asks for them. Use made-up data only (see *Security*). |
| **Starter UI demo** | `/?demo=1` runs the scripted demo with no backend. |

## Contents
[Architecture and shared state](#architecture-and-shared-state) · [The final record](#the-final-record) · [Outcomes, delivery and revisions](#outcomes-delivery-and-revisions) · [Stack and cost](#stack-and-cost-150-words) · [Product decisions](#product-decisions-where-the-brief-was-vague) · [Edge cases](#edge-cases) · [What I trust least](#what-i-trust-least) · [Cost and latency](#cost-and-latency) · [Next week](#what-i-would-do-with-another-week) · [AI tools](#ai-tools) · [Run locally](#run-it-locally) · [Security controls](#security-controls) · [JSON Schema](#json-schema) · [API reference](#api-reference)

## Architecture and shared state

```
Browser (React starter UI, same origin)
  ├─ WS /call  : mic PCM16 16 kHz in, agent PCM16 24 kHz + live transcript lines out
  └─ WS /chat  : cards, messages, record out; answers, Stop, latency samples in
        │
Node 22 server (Fastify, one process, Render free web service)
  ├─ Call engine   STT stream → turn detection → LLM (tools) → sentence chunks → TTS → audio frames
  ├─ Command processor  every state change is one command: row lock → transaction → events → publish
  ├─ Chat planner  idempotent reconciler: decides which card is open, from state alone
  ├─ Record builder + outcome machine (pure code, no I/O) · Outbox worker · Sweeper (persisted timers)
  └─ Session hub   in-process fan-out to every socket of a session
        │
Neon Postgres: sessions, events, field candidates, input requests, chat messages, transcript lines,
calls, files, usage ledger, turn metrics, records, outbox, timers, received records
Deepgram (Nova-3 STT, Aura-2 TTS) · Groq (gpt-oss-20b, then gpt-oss-120b) · Gemini (last-resort fallback)
```

**One conversation, two channels.** The two sockets are views of one session, keyed by a client-generated UUIDv4 (the session id is the capability; the server creates the session lazily on the first valid connect or upload). There is no per-channel state:

- **Every change is a command** run by one processor: it takes the session's row lock (`SELECT … FOR UPDATE`), writes in a transaction (state tables plus an append-only `events` row), and **publishes after commit**. The call engine and the chat socket both submit commands; neither writes tables directly.
- **Collected values are candidates, never overwrites.** A value from the call or from a card appends a `field_candidates` row. The *effective* field (value, source, status) and any conflict are computed by a resolver from those rows each time, so the two channels cannot drift.
- **Chat during a call:** a submitted card commits, the hub publishes, and the call engine (subscribed to the session) puts the event into the next state message the model sees; it acknowledges at a natural moment (the agent is idle and the user has been quiet for 1.2 s). Rejected or cancelled cards are reported the same way.
- **The call ends** (hang-up, dropped socket, `end_call`, server restart): `EndCall` commits, then a post-commit reconcile opens the next missing card in chat. Reconcile also runs on every chat connect and at boot, so a crash between the two steps cannot stall a session.
- **Chat reconnects** replay history, the open card and the latest record from the database (subscribing to live events first, so nothing committed during the replay is lost). A reload, a second tab and a restarted server all see the same thread.
- **A restart loses nothing:** state, files, timers and the delivery outbox are in Postgres. At boot the server marks dangling calls ended (`server_restart`), re-arms timers, reclaims expired outbox leases, runs reconcile for active sessions, and only then listens.

**The call agent.** A cascaded pipeline run on the server: Deepgram streams speech to text; the end of the user's turn is the STT end-of-utterance event; the model (tool calls `save_field`, `request_chat_input`, `flag_for_review`, `opt_out`, `end_call`, validated server-side before they run) answers; text is cut into sentences and streamed to Deepgram Aura-2; audio frames are tagged with the agent-turn id so late frames of a cancelled turn are dropped. gpt-oss-20b mostly answers with tool calls and no speech, so code speaks a templated acknowledgement from the validated calls ("Got it, Apple iPhone 14 Pro.") while the follow-up call writes the next question. **Barge-in:** speech starting while the agent talks, with at least 2 interim words or 400 ms of speech (guards against echo and coughs), first stops forwarding audio and sends `stopPlayback`, then aborts the model, and truncates the agent's transcript line to what the user actually heard (marked `[interrupted]`).

## The final record

The shape is defined by [`shared/record.schema.json`](shared/record.schema.json) (JSON Schema 2020-12, `schemaVersion: "1.0"`). Example (abridged):

```json
{
  "schemaVersion": "1.0",
  "sessionId": "9d1f0c52-7a3e-4b8e-9f2a-3c6d1e0b4a77",
  "revision": 1,
  "outcome": "completed",
  "outcomeReason": "all required fields valid; user confirmed submission",
  "previousRevision": null,
  "fields": {
    "deviceModel":  { "value": { "brand": "Apple", "model": "iPhone 14" }, "source": "call", "collectedAt": "2026-11-12T10:02:11+05:30", "status": "valid" },
    "serialNumber": { "value": { "kind": "imei", "value": "352099001761481" }, "source": "chat", "collectedAt": "2026-11-12T10:03:40+05:30", "status": "valid" },
    "additionalNotes": { "value": null, "source": null, "collectedAt": null, "status": "missing" }
  },
  "missingRequired": [],
  "conflicts": [],
  "reviewFlags": [],
  "submitConfirmation": { "confirmed": true, "source": "chat", "at": "2026-11-12T10:06:40+05:30" },
  "engagement": { "calls": 1, "callSeconds": 212, "chatMessages": 6, "chatInputsSubmitted": 5, "invalidAttempts": 1 },
  "costUsd": 0.0,
  "costBreakdownUsd": { "stt": 0.0, "llm": 0.0, "tts": 0.0, "vision": 0.0 },
  "actualSpendUsd": 0,
  "createdAt": "2026-11-12T10:06:40+05:30",
  "endedAt": "2026-11-12T10:06:40+05:30"
}
```
(The cost values above are placeholders; real records carry the session's ledger total.)

**Fields.** Collected on the call (each also has a chat-card fallback, so a session can finish in chat alone): `deviceType`, `deviceModel`, `problemDescription`, `problemStartedAt`, `urgency`. Awkward by voice, so collected in chat: `serialNumber` (serial or IMEI), `purchaseInvoice` (PDF or image), `serviceCentre` (select), `email`. Optional: `additionalPhotos`, `additionalNotes`. Completion also needs the explicit "Submit claim?" confirmation.

**Validation and normalization** (pure functions in `server/src/domain`, run on every candidate from either channel; time zone Asia/Kolkata):

| Field | Valid when | Normalized to |
|---|---|---|
| `deviceType` | maps to `smartphone`, `laptop`, `tablet`, `smartwatch`, `headphones`, `other` | the enum |
| `deviceModel` | 2–80 chars with letters; "don't know" is `invalid`, re-asked once | `{brand, model}`, brand canonicalized ("iphone" → Apple) |
| `problemDescription` | at least 3 meaningful words describing a symptom ("it's broken" alone is probed once) | `{summary ≤ 300, verbatim ≤ 1000}` |
| `problemStartedAt` | not in the future, not over 10 years ago; relative dates are resolved **in code** against the session's local date ("last Tuesday") | `{date, precision, spoken}` |
| `urgency` | maps to `low`, `normal`, `high`, `critical` | `{level, reason}` |
| `serialNumber` | IMEI: 15 digits that pass Luhn; serial: 8–20 alphanumerics, not one repeated character | uppercase, spaces and hyphens stripped, `{kind, value}` |
| `purchaseInvoice` | one file; PDF/JPEG/PNG/WebP **by magic bytes**; ≤ 10 MB; not empty | a descriptor with a signed, expiring URL |
| `serviceCentre` | an id in the **server's** list (a fictional list of six; the client's option values are never trusted) | `{id, name, city}` |
| `email` | ≤ 254 chars, one `@`, valid domain with a TLD | trimmed, domain lowercased |

All strings: Unicode NFC (NFKC for identifiers, so full-width digits become ASCII), control and invisible characters stripped, whitespace collapsed, length caps. After **3 invalid attempts** on a required field the agent stops asking; the field stays `invalid` and finalization flags it for review.

**Sanitization pipeline** in the record builder: string hygiene → per-field normalization → conflict resolution → internal fields stripped (no raw transcripts, no model evidence strings, no file paths) → files become signed descriptors → deterministic key order → JSON Schema validation (Ajv) → content hash. A record that fails its own schema is a bug: it is logged and the session is forced to `needsReview`.

**Conflicts.** A conflict exists when both channels hold a valid candidate whose *normalized* values differ (equal after normalization is recorded as agreement, `resolution: "same"`). Every conflict goes into `record.conflicts[]` with its resolution and reason.

| Field class | Winner | Why |
|---|---|---|
| `serialNumber`, `email` | **chat** (typed), always. A value heard on the call is `unverified` and never satisfies the field | speech recognition is unreliable for alphanumerics |
| `deviceType`, `serviceCentre` | the **most recent explicit choice** | the user may change their mind |
| `problemDescription`, `problemStartedAt`, `urgency` | the **call**; the chat version is kept as an addendum | richer context |
| `deviceModel` | chat if typed, else call | spelling of model names |

An identifier conflict whose losing value the user had explicitly confirmed is **unresolved**; at finalization that is review rule R-2 (`needsReview`). *Known gap: the "which is correct?" card that would let the user resolve it is not built (see [Edge cases](#edge-cases)).*

## Outcomes, delivery and revisions

Finalization runs only on these triggers: the user taps **Yes** on the "Submit claim?" card (`confirmSubmit`); the user confirms an opt-out on the call or after pressing **Stop** in chat (`optOutConfirmed`); a persisted idle timer fires after 15 minutes without a call or user activity (`idleTimeout`, configurable); and a token-gated test trigger.

| Outcome | When |
|---|---|
| `completed` | `confirmSubmit` with every required field valid. (With `AUTO_COMPLETE_ON_IDLE=true`, the default, an idle session whose required fields are all valid and no review rule hit is completed with the reason "auto-finalized after inactivity; not explicitly confirmed".) |
| `partial` | idle timeout while a required field is missing or only `unverified`; the open card stays open so the user can resume |
| `optedOut` | the user explicitly stops and confirms; fields collected so far are kept and open cards are cancelled |
| `needsReview` | any review rule hits: **R-1** a safety hazard was flagged (battery swelling, smoke, burning smell, liquid while charging); **R-2** an identifier conflict is unresolved; **R-3** a required field ended invalid (or unverified) after 3 attempts; **R-5** the agent flagged the session, or the built record failed its own schema |

Precedence: `optedOut` > `needsReview` > `completed` > `partial`.

**Delivery.** Creating a revision is one transaction: `INSERT` into `records` (unique on `(session, revision)`), the session's status change, and an `outbox` row. A crash before commit means nothing was produced; after commit it was produced once. An outbox worker POSTs the record to `RECORD_WEBHOOK_URL` (default: this server's own stub receiver, `POST /hooks/records`) with `Idempotency-Key: <sessionId>:<revision>`, retries with exponential backoff and jitter (10 attempts, then `dead`), and logs every delivery. Delivery is **at least once; the effect is exactly once** because the receiver stores `received_records(idempotency_key PRIMARY KEY)` and answers 200 for a duplicate. Deliveries of one session go **in revision order**.

**Revisions.** Explicit user activity (a card answer, a new call; not a socket reconnect) reopens a finalized session (`session.reopened`). The next finalization writes revision n+1, **only if the content hash changed**; the hash covers outcome, reason, fields, missing fields, conflicts, review flags and the confirmation, so a change in engagement or cost alone never makes a revision. Revisions are immutable (database triggers reject `UPDATE`/`DELETE` on `records`); a `partial` stays exactly as delivered and the later `completed` is a new row that names its predecessor. After `optedOut`, a returning user is first asked "Resume your claim?"; No keeps the session opted out with no new revision. Sessions close 7 days after last activity (no reopen, no new revision; a pending finalize fires first, so every session gets a record).

## Stack and cost (150 words)

<!-- stack-section:start -->
Server-side cascaded pipeline: it gives full control of interruption and transcript truncation, and keeps every key off the browser. Deepgram Nova-3 streams speech to text; Groq `openai/gpt-oss-20b` decides (fallbacks: gpt-oss-120b, then Gemini); Deepgram Aura-2 speaks. Node 22, Fastify and WebSockets run on one Render free web service beside Neon Postgres, which holds all state, files and the delivery outbox. The browser is the starter UI. Every provider is on a free tier, so actual spend is $0. Cost per session is reported as a list-price equivalent from a usage ledger priced at each provider's published rates. **Measured cost per completed session: `PENDING`. It must come from the deployed system, and none exists yet.** Method and prices are under Cost and latency.
<!-- stack-section:end -->

## Product decisions where the brief was vague

- **Scenario:** a device repair claim, with the call/chat split above and two optional fields (`additionalPhotos`, `additionalNotes`, offered once near the end and skippable).
- **One page, one session:** the call and the chat share the starter's single page; the same session link works in a second tab and both get every broadcast.
- **Completion needs an explicit confirmation card in chat.** A spoken "yes" is not enough: the business receives a confirmed record, and a misheard word cannot submit it.
- **Identifiers must be typed.** A spoken serial number or email is saved as `unverified` and the agent asks the user to type it.
- **Stop button:** the chat has no free-text field, so a header **Stop** opens a confirmation card; only Yes opts out.
- **Silence:** the agent re-prompts at 8 s; after two re-prompts the call ends and the chat continues.
- **Safety:** a hazard (battery swelling, smoke, burning smell) makes the agent advise stopping use of the device and flags `needsReview`.
- **Consent line:** the call opens with a short note that it is processed as text; raw audio is never stored.
- **Service centres are a fictional list** ("… Demo Repair Centre"), so no real business is impersonated.
- **A user who never calls** still gets the chat: after 2 minutes without a call the chat starts with a message and the first card.
- **Data is kept** until the review period ends, then should be purged. *No purge script is built yet (see Edge cases).*

## Edge cases

**Handled** (each has an automated test; scenario tests drive a real server through both sockets with fake providers):
- A card answered while the call is on, and the agent acknowledging it; a rejected or cancelled card reaching the call.
- The call dropping at any point, then finishing in chat; a returning call that knows what was collected and the last question asked.
- Invalid answers (three attempts, then no more asking and a review flag); a duplicate submit; a stale card answered after it was cancelled.
- The same answer from both channels (agreement) and different answers (resolved by policy and recorded).
- A reload mid-session, a second tab, a chat reconnect without a reload (no duplicate thread items, the open card reconciled).
- A server restart with a live call and a card open; a record that must not be produced or delivered twice; delivery retries; an outbox row left leased by a dead worker.
- An idle `partial` user returning to finish (revision 2, revision 1 untouched); opt-out by call and by chat, and a resume offer afterwards.
- Uploads: a renamed `.exe`, an empty file, a file over 10 MB, a forged select value, a tampered or expired file link.
- Provider failures: the model rate-limited or down (next model, then Gemini), STT dropping (one reconnect, then the call ends and chat continues), TTS errors, an exhausted free-tier quota (voice politely refused, chat still works).
- Abuse: foreign Origin, oversized or malformed frames, floods of messages, many new sessions from one IP, concurrent calls beyond the cap.

**Known not to be handled** (or handled only partly):
- **No "which is correct?" card for an identifier conflict.** The resolver detects it and marks it unresolved, so today it ends in `needsReview` (R-2) without asking the user.
- **A typed edit of a narrative field** (problem, start date, urgency) on the edit card is not offered, because the spoken account wins by policy.
- **English only.** The date resolver has no festival names ("around Diwali" is re-asked) and no "last year". Aura-2 has no Indian-accent voice.
- **An opted-out user** is offered "Resume your claim?" only when they try to call again; chat has no other control for it.
- **A silent session with no activity at all** never finalizes (only the no-call timer runs).
- **Single instance:** the rate limiter, the call cap and the quota override live in process memory. Two instances during a deploy overlap stay consistent for session data (row locks, `SKIP LOCKED`), but not for these limits.
- **Free-tier ceilings:** the Groq limit (8,000 tokens a minute per model) caps concurrent calls at 1 by default; Neon's 1 GB and 100 compute-hours bound the data and the always-on time.
- **The call's live state does not survive a restart:** the call ends and the user taps Call again (a new call resumes from state; no automatic redial).
- **Vision checks of uploads, other languages, the debug view and the post-review data purge** are not built.

## What I trust least

1. **The model's choices on a real call.** The server's handling of tool calls is tested with scripted models, and the pipeline was measured in a spike, but the deployed agent has not yet been exercised end to end with real providers; whether it requests chat cards at good moments, and whether the acknowledgement regexes in the deployed check match what it really says, are unproven. This is the least verified part.
2. **Barge-in latency from the reviewer's network.** The stop-after-speech-onset budget (1.0 s) was measured at 1.40–1.48 s from India in the spike, because Deepgram detects words late from there. It may fail on the deployed check.
3. **The free tiers themselves.** Their limits are not guaranteed, and a provider outage or quota end degrades the call to chat-only (by design, but a worse demo).
4. **The browser latency probe.** Its thresholds are untested guesses; the number is secondary and noisy with speakers.
5. **Anything that runs only on Render:** proxy headers (client IP), the sleep/wake cycle of the free instance and the restart check have not been exercised against a real deployment.

## Cost and latency

> **`PENDING`: no measurement from the deployed system exists.** The tooling is built and tested (`server/scripts/report.ts`, below), but a report needs the deployment, at least 10 completed real sessions and at least 50 voice turns. No cost or latency figure is claimed here.

**How cost is worked out.** Every billable unit is a row in a usage ledger, priced when inserted at the provider's published paid list price (`server/src/metrics/prices.ts`, each entry with its source URL and the date it was read, 2026-11-10). Actual spend is **$0** because every provider is on a free tier; the reported figure is the **list-price equivalent**:

| Meter | List price used |
|---|---|
| Deepgram Nova-3 streaming STT | $0.0077 per minute (billed per second) |
| Deepgram Aura-2 TTS | $0.030 per 1,000 characters |
| Groq `openai/gpt-oss-20b` | $0.075 in / $0.30 out per 1M tokens |
| Groq `openai/gpt-oss-120b` (fallback) | $0.15 in / $0.60 out per 1M tokens |
| Gemini `gemini-flash-lite-latest` (last resort, priced as Gemini 3.5 Flash-Lite) | $0.30 in / $2.50 out / $0.03 cached per 1M tokens |
| Neon, Render | $0 at this scale |

Assumptions that move the number: Groq lists no cached-input rate, so cached tokens are priced at the input rate (an upper bound); Google does not publish which model the `-latest` alias points to. A session's cost is the exact sum of its ledger rows and is written into its record (`costUsd`, with `costBreakdownUsd`).

**How latency is measured.** The primary number is **server-side**: from the STT end-of-utterance event (Deepgram `speech_final`) to the first TTS audio frame written to the socket, for every agent reply that follows a user utterance, with stage timings beside it (the merge wait, the model's first token, TTS's first byte). A secondary, noisy **browser-side** number (mic level below a threshold for 300 ms after speech, to the first agent audio scheduled to play) is reported separately. Percentiles are nearest rank, so every p50 and p95 is an observed value. The report states n, the dates, the region, the browsers and whether headphones were worn.

**What exists today** (a spike, not a measurement of this system): a laptop on home Wi-Fi in India, 20 runs of the same pipeline per variant, speech end to first audio byte, measured against the providers directly: **1,656 ms p50 / 1,768 ms p95** with the acknowledge-then-ask design, versus 2,311 / 2,513 ms when waiting for the model's follow-up speech. These include two round trips from the laptop to Deepgram that the deployed server will not have; the spike's own conservative estimate for the deployed system is about 1.3–1.4 s p50. **That estimate is not a measurement.**

To produce the real numbers once deployed: run the sessions, then `DATABASE_URL=<Neon URL> npm run report -w server -- --region "…" --browsers "…" --headphones yes` (see `server/scripts/report.ts`). It reads the database in a read-only transaction.

## What I would do with another week

- Build the missing **identifier-conflict card** and let a typed edit change a narrative field.
- Run the deployed checks for real: the E2E script twice, a restart under a live call, two phones, and tune barge-in and endpointing against the measured numbers.
- A call **auto-redial** after a drop, and **Hindi** plus one more Indian language (needs an STT/TTS pairing with Indian voices).
- **Vision check** of the invoice and photos (review rule R-4 is reserved for it).
- A `/debug/:sessionId` timeline page on top of the existing `GET /api/sessions/:id/timeline`.
- Move the in-memory limits to the database so more than one instance behaves identically, and raise the call cap after measuring Groq 429s.

## AI tools

Claude Code (Anthropic) wrote most of the code and tests under my direction, and drafted the plan, the decision log and this README from them. **Where it helped:** writing the many small, exact pieces (validators, the resolver, the outcome machine, the protocol schemas, test scaffolding) and finding gaps by reviewing its own work against the plan. **Where it misled, caught by tests or review rather than by trusting it:**
- A rule for 3 failed attempts ignored fields that were only *heard* on the call, so a spoken serial typed wrongly three times ended `partial` with no review flag (found in an audit of the outcome rules, fixed with a test).
- After a chat reconnect without a reload, a card could stay open that another tab had answered (found reviewing the replay, fixed).
- It treated "audio sent" as "audio heard", which broke barge-in and silence timing because Aura-2 streams faster than real time (found in a real call, fixed to follow playback).
- A first network-latency script reported a figure that was off by about 5x (a proxy and an IPv6 fallback) and was nearly used in a decision; it was caught as implausible and the script fixed.
- It assumed what Gemini's `-latest` alias points to and that Groq has a cached-token rate; both are now stated as assumptions next to the prices.
- A scenario test for the identifier-conflict card could not pass because nothing implements that card; the plan had listed the scenario without a task to build it.

## Run it locally

Needs **Node 22.18+** (`.nvmrc`), **npm**, and a **Postgres** database (a free Neon database, or local Postgres 18). Provider keys are only needed for voice; without them the chat, cards, records and the API work, and a call is refused.

```bash
npm ci
cp server/.env.example server/.env      # then edit server/.env (it is gitignored; never commit it)
npm run build
npm start                               # http://localhost:8080 (the server also serves the built web UI)
```

In `server/.env` set at least:

| Variable | Value |
|---|---|
| `DATABASE_URL` | your Postgres URL (Neon: the pooled string with `sslmode=require`) |
| `PUBLIC_ORIGIN` | `http://localhost:8080` (the browser's origin; WebSockets check it) |
| `FILE_URL_SECRET`, `HOOK_SECRET` | random strings of 32+ characters: `openssl rand -base64 32` |
| `DEEPGRAM_API_KEY`, `GROQ_API_KEY` | your keys, for voice. `GEMINI_API_KEY` is the optional last-resort fallback |

Migrations run when the server boots. Everything else has a default; see `server/.env.example`, which documents each variable (names only, never values). Open `http://localhost:8080`, tap **Call** for voice, or just use the chat cards.

**Check the API** (the examples in this README, run against a server): `scripts/check-api-examples.sh http://localhost:8080`.

**Tests**

```bash
npm run lint && npm run typecheck
npm test                 # unit, integration and scenario tests on a throwaway Postgres
npm run test:coverage    # the same, enforcing ≥ 90% branch coverage on the domain core
npm run e2e              # Playwright (Chromium) against the built app with fake providers
```
`npm test` needs a disposable Postgres: set `TEST_DATABASE_URL`, or install Postgres 18 (for example `brew install postgresql@18`) and it starts a temporary cluster itself. Tests never touch your real database. Tests use **fake STT, LLM and TTS**; they prove the server's logic, not that a provider works. Opt-in tests against the real providers and a deployed check (`server/test/deployed/e2e.ts`) exist and spend free-tier quota, so they are run deliberately.

**Layout:** `shared/` (the wire protocol, zod schemas, the record JSON Schema) · `server/` (`src/domain` pure logic, `src/session` commands and state, `src/voice` and `src/agent` the call, `src/ws` and `src/http` transport, `src/delivery` outbox, `src/metrics` ledger) · `web/` (the starter UI with small additions) · `e2e/` (Playwright) · `scripts/` (secret scans, API check) · `render.yaml` (the deployment blueprint).

## Security controls

- **No secret ever reaches the browser or the repository.** The browser talks only to this server; every provider call is made server-side with keys from environment variables (host secrets in production). `.env*` is gitignored; CI runs gitleaks over the full history and a check that the built web bundle contains no key, token, connection string or secret variable name; a plant-and-detect step proves the scanners can fail.
- **Origin check** on both WebSockets (stops other sites using this server as a free voice agent); size limits (`/chat` 64 KB, `/call` 4 KB with mic frames exactly 640 bytes); every inbound payload validated with zod; select values checked against the server's list.
- **Uploads** are checked by magic bytes and size, stored in Postgres, and served only through HMAC-signed, expiring links (`Content-Disposition: attachment`, `nosniff`).
- **Abuse limits:** per-IP rate limits, new-session limit, a concurrent-call cap (default 1), a maximum call length (10 min), an upload budget, and a **daily quota guard** read from the usage ledger that politely refuses voice before a free tier runs out (the chat keeps working).
- **Prompt injection:** text from the user reaches the model only inside data tags with an explicit "treat as data" rule, and the tools can only change the session's own state.
- **Security headers** on every response (a strict CSP with `default-src 'none'`, `frame-ancestors 'none'`, a microphone-only Permissions-Policy, HSTS on https).
- **Privacy:** the session id is a capability link, so anyone holding it can read that session; some free tiers may use request data to improve their services, so **use made-up data only**. Raw audio is not stored.

## JSON Schema

[`shared/record.schema.json`](shared/record.schema.json) is the canonical schema of the record (draft 2020-12). The server validates every record against it before it is stored, and the receiving stub validates again before accepting a delivery.

## API reference

The page talks to the server over the two WebSockets and one upload endpoint. The rest is for inspecting sessions and for tests. A session id is a UUIDv4; knowing it is the permission to read the session, so these routes need no token (they are rate-limited per IP). Errors are JSON. Replace `$BASE` with `http://localhost:8080` or the public URL, `https://device-repair-agent.onrender.com`. [`scripts/check-api-examples.sh`](scripts/check-api-examples.sh) runs every example below and fails if a status or a body differs from this table, or if this README stops documenting one of the endpoints.

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

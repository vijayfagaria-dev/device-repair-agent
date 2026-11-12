# The final record

The record's shape is defined by [`shared/record.schema.json`](shared/record.schema.json) (JSON Schema 2020-12, `schemaVersion: "1.0"`). An abridged example:

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

**Fields.** Collected on the call, each with a chat-card fallback so a session can finish in chat alone: `deviceType`, `deviceModel`, `problemDescription`, `problemStartedAt`, `urgency`. Awkward by voice, so collected in chat: `serialNumber` (serial or IMEI), `purchaseInvoice`, `serviceCentre`, `email`. Optional: `additionalPhotos`, `additionalNotes`. Completion also needs the explicit "Submit claim?" confirmation. In the page, the record is shown as readable text (for example "Apple iPhone 14", "10 Nov 2026", "PNG, 79 KB"); the JSON above is what is delivered.

## Validation and normalization

Pure functions in `app/domain` run on every candidate from either channel, in the Asia/Kolkata time zone:

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

## Sanitization pipeline

The record builder runs: string hygiene → per-field normalization → conflict resolution → internal fields stripped (no raw transcripts, no model evidence strings, no file paths) → files become signed descriptors → deterministic key order → JSON Schema validation (Ajv) → content hash. A record that fails its own schema is a bug: it is logged and the session is forced to `needsReview`.

## Conflicts between channels

**Conflicts.** A conflict exists when both channels hold a valid candidate whose *normalized* values differ (equal after normalization is recorded as agreement, `resolution: "same"`). Every conflict goes into `record.conflicts[]` with its resolution and reason.

| Field class | Winner | Why |
|---|---|---|
| `serialNumber`, `email` | **chat** (typed), always. A value heard on the call is `unverified` and never satisfies the field | speech recognition is unreliable for alphanumerics |
| `deviceType`, `serviceCentre` | the **most recent explicit choice** | the user may change their mind |
| `problemDescription`, `problemStartedAt`, `urgency` | the **call**; the chat version is kept as an addendum | richer context |
| `deviceModel` | chat if typed, else call | spelling of model names |

An identifier conflict whose losing value the user had explicitly confirmed is **unresolved**; at finalization that is review rule R-2 (`needsReview`). *Known gap: the "which is correct?" card that would let the user resolve it is not built (see [reliability](reliability.md)).*

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

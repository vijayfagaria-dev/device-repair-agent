-- Schema v1 (architecture.md §4). Applied by src/db/migrate.ts inside one transaction: no BEGIN/COMMIT here.
-- Objects are created in the current schema (no schema prefix), so tests can migrate a schema of their own.

-- Rejects every change to an append-only table. Statement-level, so it fires even when no row matches.
CREATE FUNCTION reject_append_only_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table "%": % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Insert a new row instead (corrections are new candidates, revisions are new records).';
END;
$$;

-- One row per session. The id is the browser's UUIDv4 (D08); rows are created lazily on first use.
CREATE TABLE sessions (
  id               uuid PRIMARY KEY,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'finalized', 'closed')),
  outcome          text CHECK (outcome IN ('completed', 'partial', 'optedOut', 'needsReview')),
  version          integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  current_revision integer NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
  language         text NOT NULL DEFAULT 'en',
  active_call_id   text,
  open_request_id  text,
  review_flags     jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(review_flags) = 'array'),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- The session timeline (D12). Append-only.
CREATE TABLE events (
  session_id uuid NOT NULL REFERENCES sessions (id),
  seq        integer NOT NULL CHECK (seq > 0),
  type       text NOT NULL,
  channel    text NOT NULL CHECK (channel IN ('call', 'chat', 'system')),
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT events_session_seq_key UNIQUE (session_id, seq)
);

-- Every value ever offered for a field (D11, D15). Append-only: a correction is a new row.
CREATE TABLE field_candidates (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id     uuid NOT NULL REFERENCES sessions (id),
  event_seq      integer NOT NULL,
  field          text NOT NULL,
  source         text NOT NULL CHECK (source IN ('call', 'chat')),
  raw            jsonb NOT NULL,
  normalized     jsonb,
  status         text NOT NULL CHECK (status IN ('valid', 'invalid', 'skipped', 'unverified')),
  error          text,
  user_confirmed boolean NOT NULL DEFAULT false,
  collected_at   timestamptz NOT NULL DEFAULT now(),
  evidence       text,
  -- Deferred: a command may write snapshot rows before appending the event (D11), within one transaction.
  CONSTRAINT field_candidates_event_fkey FOREIGN KEY (session_id, event_seq)
    REFERENCES events (session_id, seq) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX field_candidates_session_field_idx ON field_candidates (session_id, field, id);

-- Chat messages, replayed in event order (protocol.md §4). id = chatMessageId (wire id m_<id>).
CREATE TABLE chat_messages (
  id         text PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions (id),
  event_seq  integer NOT NULL,
  role       text NOT NULL CHECK (role IN ('agent', 'user')),
  text       text NOT NULL,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_messages_event_fkey FOREIGN KEY (session_id, event_seq)
    REFERENCES events (session_id, seq) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX chat_messages_session_seq_idx ON chat_messages (session_id, event_seq);

-- Input cards (D13). id = req_<field>_<n>, unique within a session. At most one open card per session.
CREATE TABLE input_requests (
  session_id uuid NOT NULL REFERENCES sessions (id),
  id         text NOT NULL,
  field      text NOT NULL,
  spec       jsonb NOT NULL,
  status     text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'open', 'answered', 'cancelled')),
  attempts   integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, id)
);
CREATE UNIQUE INDEX input_requests_one_open_idx ON input_requests (session_id) WHERE status = 'open';

-- Persisted business timers (D16), one per kind per session; fired by the sweeper in due order.
CREATE TABLE timers (
  session_id uuid NOT NULL REFERENCES sessions (id),
  kind       text NOT NULL CHECK (kind IN ('idle', 'noCallStart', 'orphanUploads', 'sessionExpiry')),
  due_at     timestamptz NOT NULL,
  PRIMARY KEY (session_id, kind)
);
CREATE INDEX timers_due_at_idx ON timers (due_at);

-- Voice calls. At most one active (not ended) call per session (close code 4409).
CREATE TABLE calls (
  id         text PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions (id),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at   timestamptz,
  end_reason text,
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE UNIQUE INDEX calls_one_active_idx ON calls (session_id) WHERE ended_at IS NULL;

-- Final transcript lines only (interim text is never stored). id = tu_<callId>_<n> / ta_<callId>_<n>.
CREATE TABLE transcript_lines (
  id          text PRIMARY KEY,
  session_id  uuid NOT NULL REFERENCES sessions (id),
  call_id     text NOT NULL REFERENCES calls (id),
  event_seq   integer NOT NULL,
  role        text NOT NULL CHECK (role IN ('agent', 'user')),
  text        text NOT NULL,
  interrupted boolean NOT NULL DEFAULT false,
  started_at  timestamptz NOT NULL,
  CONSTRAINT transcript_lines_event_fkey FOREIGN KEY (session_id, event_seq)
    REFERENCES events (session_id, seq) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX transcript_lines_session_seq_idx ON transcript_lines (session_id, event_seq);

-- Uploaded file metadata (D10: PDF, JPEG, PNG, WebP by magic bytes; at most 10 MB each).
CREATE TABLE files (
  id            text PRIMARY KEY,
  session_id    uuid NOT NULL REFERENCES sessions (id),
  mime          text NOT NULL CHECK (mime IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  size          integer NOT NULL CHECK (size > 0 AND size <= 10485760),
  sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  original_name text,
  check_result  jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX files_session_idx ON files (session_id);

-- File bytes, kept apart from metadata so listing files never reads blobs.
CREATE TABLE file_blobs (
  file_id text PRIMARY KEY REFERENCES files (id) ON DELETE CASCADE,
  bytes   bytea NOT NULL
);

-- Provider usage ledger (P3-T07): cost at list prices; actual spend is $0 on free tiers (D20).
CREATE TABLE usage (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions (id),
  provider   text NOT NULL,
  kind       text NOT NULL,
  units      numeric NOT NULL CHECK (units >= 0),
  unit       text NOT NULL,
  cost_usd   numeric(14, 8) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_session_idx ON usage (session_id);

-- Per-turn latency (D19). turn_id = the agent transcript id (ta_…); client_ms arrives later via clientMetric.
CREATE TABLE turn_metrics (
  turn_id        text PRIMARY KEY,
  session_id     uuid NOT NULL REFERENCES sessions (id),
  call_id        text NOT NULL REFERENCES calls (id),
  user_end_at    timestamptz,
  first_audio_at timestamptz,
  server_ms      integer,
  client_ms      integer,
  stt_ms         integer,
  llm_ttft_ms    integer,
  tts_ttfb_ms    integer
);
CREATE INDEX turn_metrics_session_idx ON turn_metrics (session_id);

-- Immutable record revisions (D17). Append-only.
CREATE TABLE records (
  session_id   uuid NOT NULL REFERENCES sessions (id),
  revision     integer NOT NULL CHECK (revision > 0),
  outcome      text NOT NULL CHECK (outcome IN ('completed', 'partial', 'optedOut', 'needsReview')),
  payload      jsonb NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT records_session_revision_key UNIQUE (session_id, revision)
);

-- Transactional outbox (D17): one row per revision and delivery target, written with the record.
CREATE TABLE outbox (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id      uuid NOT NULL,
  revision        integer NOT NULL,
  target          text NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'delivered', 'dead')),
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  CONSTRAINT outbox_session_revision_target_key UNIQUE (session_id, revision, target),
  CONSTRAINT outbox_record_fkey FOREIGN KEY (session_id, revision) REFERENCES records (session_id, revision)
);
CREATE INDEX outbox_due_idx ON outbox (next_attempt_at) WHERE status IN ('pending', 'sending');

-- The stub receiver's dedup table (P7-T04): the same Idempotency-Key is stored once.
CREATE TABLE received_records (
  idempotency_key   text PRIMARY KEY,
  payload           jsonb NOT NULL,
  first_received_at timestamptz NOT NULL DEFAULT now(),
  last_received_at  timestamptz NOT NULL DEFAULT now(),
  times_received    integer NOT NULL DEFAULT 1 CHECK (times_received >= 1)
);

CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER field_candidates_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON field_candidates
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER records_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON records
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_change();

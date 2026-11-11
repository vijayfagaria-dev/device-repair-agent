// Constraints and append-only triggers of 001_init.sql, against a real Postgres.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { createTestSchema, type TestSchema } from "./helpers/db.js";

const HASH = "a".repeat(64);
let schema: TestSchema;
let pool: pg.Pool;

beforeAll(async () => {
  schema = await createTestSchema("sch");
  pool = schema.open().pool;
  await migrate(pool);
});
afterAll(async () => {
  await schema.drop();
});

async function newSession(): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO sessions (id) VALUES ($1)", [id]);
  return id;
}

async function addEvent(sessionId: string, seq: number): Promise<void> {
  await pool.query("INSERT INTO events (session_id, seq, type, channel) VALUES ($1, $2, 'session.created', 'system')", [sessionId, seq]);
}

async function addRecord(sessionId: string, revision: number): Promise<void> {
  await pool.query("INSERT INTO records (session_id, revision, outcome, payload, content_hash) VALUES ($1, $2, 'partial', '{}', $3)", [
    sessionId,
    revision,
    HASH,
  ]);
}

/** Runs statements in one transaction and returns the error (or null) at COMMIT time. */
async function inTransaction(statements: Array<[string, unknown[]]>): Promise<{ code?: string } | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [sql, values] of statements) await client.query(sql, values);
    await client.query("COMMIT");
    return null;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    return err as { code?: string };
  } finally {
    client.release();
  }
}

describe("append-only triggers", () => {
  it("UPDATE records … fails with the trigger error", async () => {
    const s = await newSession();
    await addRecord(s, 1);
    await expect(pool.query("UPDATE records SET outcome = 'completed' WHERE session_id = $1", [s])).rejects.toMatchObject({
      code: "23001",
      message: 'append-only table "records": UPDATE is not allowed',
    });
    const { rows } = await pool.query("SELECT outcome FROM records WHERE session_id = $1", [s]);
    expect(rows).toEqual([{ outcome: "partial" }]);
  });

  it("DELETE FROM events … fails with the trigger error", async () => {
    const s = await newSession();
    await addEvent(s, 1);
    await expect(pool.query("DELETE FROM events WHERE session_id = $1", [s])).rejects.toMatchObject({
      code: "23001",
      message: 'append-only table "events": DELETE is not allowed',
    });
    expect((await pool.query("SELECT count(*)::int AS n FROM events WHERE session_id = $1", [s])).rows[0].n).toBe(1);
  });

  it("blocks UPDATE, DELETE and TRUNCATE on all three tables, even when no row matches", async () => {
    for (const table of ["records", "events", "field_candidates"]) {
      for (const sql of [
        `UPDATE ${table} SET session_id = session_id WHERE false`,
        `DELETE FROM ${table} WHERE false`,
        `TRUNCATE ${table} CASCADE`,
      ]) {
        await expect(pool.query(sql), sql).rejects.toMatchObject({ code: "23001" });
      }
    }
  });

  it("still allows appending, including a correction as a new candidate", async () => {
    const s = await newSession();
    await addEvent(s, 1);
    await addEvent(s, 2);
    const insert = "INSERT INTO field_candidates (session_id, event_seq, field, source, raw, status) VALUES ($1, $2, 'deviceModel', $3, $4, $5)";
    await pool.query(insert, [s, 1, "call", JSON.stringify("iPhone 14"), "valid"]);
    await pool.query(insert, [s, 2, "chat", JSON.stringify("iPhone 14 Pro"), "valid"]);
    const { rows } = await pool.query("SELECT raw FROM field_candidates WHERE session_id = $1 ORDER BY id", [s]);
    expect(rows.map((r) => r.raw)).toEqual(["iPhone 14", "iPhone 14 Pro"]);
  });
});

describe("uniqueness", () => {
  it("UNIQUE(session_id, seq) on events", async () => {
    const s = await newSession();
    await addEvent(s, 1);
    await expect(addEvent(s, 1)).rejects.toMatchObject({ code: "23505", constraint: "events_session_seq_key" });
    await addEvent(await newSession(), 1); // the same seq in another session is fine
  });

  it("UNIQUE(session_id, revision) on records", async () => {
    const s = await newSession();
    await addRecord(s, 1);
    await expect(addRecord(s, 1)).rejects.toMatchObject({ code: "23505", constraint: "records_session_revision_key" });
    await addRecord(s, 2);
  });

  it("UNIQUE(session_id, revision, target) on outbox, which must point at an existing record", async () => {
    const s = await newSession();
    await addRecord(s, 1);
    const insert = "INSERT INTO outbox (session_id, revision, target) VALUES ($1, $2, $3)";
    await pool.query(insert, [s, 1, "webhook"]);
    await expect(pool.query(insert, [s, 1, "webhook"])).rejects.toMatchObject({ code: "23505", constraint: "outbox_session_revision_target_key" });
    await pool.query(insert, [s, 1, "log"]);
    await expect(pool.query(insert, [s, 2, "webhook"])).rejects.toMatchObject({ code: "23503", constraint: "outbox_record_fkey" });
  });

  it("at most one open input request per session", async () => {
    const s = await newSession();
    const insert = "INSERT INTO input_requests (session_id, id, field, spec, status) VALUES ($1, $2, $3, '{}', $4)";
    await pool.query(insert, [s, "req_serialNumber_1", "serialNumber", "open"]);
    await pool.query(insert, [s, "req_email_1", "email", "queued"]);
    await expect(pool.query(insert, [s, "req_invoice_1", "purchaseInvoice", "open"])).rejects.toMatchObject({
      code: "23505",
      constraint: "input_requests_one_open_idx",
    });
  });

  it("at most one active call per session", async () => {
    const s = await newSession();
    await pool.query("INSERT INTO calls (id, session_id, ended_at) VALUES ('c1', $1, now())", [s]);
    await pool.query("INSERT INTO calls (id, session_id) VALUES ('c2', $1)", [s]);
    await expect(pool.query("INSERT INTO calls (id, session_id) VALUES ('c3', $1)", [s])).rejects.toMatchObject({
      code: "23505",
      constraint: "calls_one_active_idx",
    });
  });
});

describe("checks, keys and indexes", () => {
  it("rejects values outside the allowed sets", async () => {
    const s = await newSession();
    const cases: Array<[string, unknown[]]> = [
      ["INSERT INTO sessions (id, status) VALUES ($1, 'paused')", [randomUUID()]],
      ["INSERT INTO sessions (id, outcome) VALUES ($1, 'done')", [randomUUID()]],
      ["INSERT INTO events (session_id, seq, type, channel) VALUES ($1, 1, 'x', 'sms')", [s]],
      ["INSERT INTO timers (session_id, kind, due_at) VALUES ($1, 'nap', now())", [s]],
      ["INSERT INTO files (id, session_id, mime, size, sha256) VALUES ('f1', $1, 'image/heic', 10, $2)", [s, HASH]],
      ["INSERT INTO files (id, session_id, mime, size, sha256) VALUES ('f2', $1, 'image/png', 10485761, $2)", [s, HASH]],
      ["INSERT INTO records (session_id, revision, outcome, payload, content_hash) VALUES ($1, 1, 'completed', '{}', 'nothex')", [s]],
      ["INSERT INTO outbox (session_id, revision, target, status) VALUES ($1, 1, 'w', 'lost')", [s]],
    ];
    for (const [sql, values] of cases) await expect(pool.query(sql, values), sql).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects rows for unknown sessions", async () => {
    await expect(pool.query("INSERT INTO timers (session_id, kind, due_at) VALUES ($1, 'idle', now())", [randomUUID()])).rejects.toMatchObject({
      code: "23503",
    });
  });

  it("lets a command write a candidate before its event in the same transaction, but never without it", async () => {
    const s = await newSession();
    const candidate: [string, unknown[]] = [
      "INSERT INTO field_candidates (session_id, event_seq, field, source, raw, status) VALUES ($1, 5, 'email', 'chat', '\"a@b.co\"', 'valid')",
      [s],
    ];
    const event: [string, unknown[]] = ["INSERT INTO events (session_id, seq, type, channel) VALUES ($1, 5, 'field.candidate', 'chat')", [s]];
    expect(await inTransaction([candidate, event])).toBeNull();
    const orphan = await inTransaction([[candidate[0].replace("5,", "6,"), [s]]]);
    expect(orphan).toMatchObject({ code: "23503" });
  });

  it("has the timers(due_at) index", async () => {
    const { rows } = await pool.query("SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'timers_due_at_idx'");
    expect(rows[0]?.indexdef).toMatch(/ON \S*timers USING btree \(due_at\)/);
  });

  it("uses jsonb and timestamptz columns", async () => {
    const { rows } = await pool.query<{ data_type: string; n: number }>(
      "SELECT data_type, count(*)::int AS n FROM information_schema.columns WHERE table_schema = current_schema() AND (column_name LIKE '%\\_at' OR column_name IN ('payload', 'spec', 'raw', 'normalized', 'review_flags', 'check_result')) GROUP BY 1 ORDER BY 1",
    );
    expect(rows.map((r) => r.data_type).sort()).toEqual(["jsonb", "timestamp with time zone"]);
  });
});

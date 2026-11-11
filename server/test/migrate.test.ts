import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrate, MigrationError } from "../src/db/migrate.js";
import { createTestSchema, type TestSchema } from "./helpers/db.js";

const EXPECTED_TABLES = [
  "calls", "chat_messages", "events", "field_candidates", "file_blobs", "files", "input_requests", "outbox",
  "received_records", "records", "schema_migrations", "sessions", "timers", "transcript_lines", "turn_metrics", "usage",
];

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function schema(): Promise<TestSchema> {
  const s = await createTestSchema("mig");
  cleanup.push(() => s.drop());
  return s;
}

function migrationsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "migrations-"));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function tables(db: ReturnType<TestSchema["open"]>): Promise<string[]> {
  const { rows } = await db.pool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY 1",
  );
  return rows.map((r) => r.table_name);
}

describe("migrate (real migrations)", () => {
  it("creates the whole schema on an empty database, then applies nothing on the second run", async () => {
    const s = await schema();
    const db = s.open();
    expect(await tables(db)).toEqual([]);

    expect(await migrate(db.pool)).toEqual({ applied: ["001_init"] });
    expect(await tables(db)).toEqual(EXPECTED_TABLES);
    const { rows } = await db.pool.query("SELECT version, name FROM schema_migrations");
    expect(rows).toEqual([{ version: 1, name: "001_init" }]);

    expect(await migrate(db.pool)).toEqual({ applied: [] });
    expect((await db.pool.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0].n).toBe(1);
  });

  it("applies each migration exactly once when several processes boot at the same time", async () => {
    const s = await schema();
    const pools = Array.from({ length: 6 }, () => s.open());
    const results = await Promise.all(pools.map((db) => migrate(db.pool)));
    const applied = results.flatMap((r) => r.applied);
    expect(applied).toEqual(["001_init"]);
    expect(await tables(s.open())).toEqual(EXPECTED_TABLES);
  });
});

describe("migrate (runner behaviour)", () => {
  it("serialises slow, non-idempotent migrations across concurrent runners", async () => {
    const s = await schema();
    // Without the lock, overlapping runners would both run CREATE TABLE and one would fail.
    const dir = migrationsDir({
      "001_slow.sql": "SELECT pg_sleep(0.3); CREATE TABLE once_only (id int);",
      "002_next.sql": "CREATE TABLE also_once (id int); INSERT INTO also_once VALUES (1);",
    });
    const pools = Array.from({ length: 5 }, () => s.open());
    const results = await Promise.all(pools.map((db) => migrate(db.pool, dir)));
    expect(results.flatMap((r) => r.applied).sort()).toEqual(["001_slow", "002_next"]);
    expect((await s.open().pool.query("SELECT count(*)::int AS n FROM also_once")).rows[0].n).toBe(1);
  });

  it("rolls a failing migration back completely and records nothing for it", async () => {
    const s = await schema();
    const db = s.open();
    const dir = migrationsDir({
      "001_ok.sql": "CREATE TABLE ok_table (id int);",
      "002_broken.sql": "CREATE TABLE half_done (id int); SELECT 1 / 0;",
    });
    await expect(migrate(db.pool, dir)).rejects.toMatchObject({ code: "22012" });
    expect(await tables(db)).toEqual(["ok_table", "schema_migrations"]);
    expect((await db.pool.query("SELECT name FROM schema_migrations")).rows).toEqual([{ name: "001_ok" }]);
  });

  it("refuses to boot when an applied migration was edited", async () => {
    const s = await schema();
    const db = s.open();
    const dir = migrationsDir({ "001_a.sql": "CREATE TABLE a (id int);" });
    await migrate(db.pool, dir);
    writeFileSync(join(dir, "001_a.sql"), "CREATE TABLE a (id bigint);");
    await expect(migrate(db.pool, dir)).rejects.toThrow(/was changed after it was applied/);
  });

  it("rejects badly named or non-contiguous migration files", () => {
    expect(() => loadMigrations(migrationsDir({ "1_init.sql": "" }))).toThrow(MigrationError);
    expect(() => loadMigrations(migrationsDir({ "001_a.sql": "", "003_c.sql": "" }))).toThrow(/contiguous/);
    expect(loadMigrations().map((m) => m.name)).toEqual(["001_init"]);
  });
});

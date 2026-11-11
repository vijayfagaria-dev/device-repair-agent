// Versioned SQL migrations, applied at boot (D09).
// Each migration runs in its own transaction, guarded by a transaction-scoped advisory lock. Session-level locks
// don't work through Neon's transaction-mode pooler; `pg_advisory_xact_lock` does. Two instances booting at once
// therefore apply each migration exactly once: the second waits, then sees it recorded and skips it.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";
import { isTransientDbError } from "./pool.js";

/** `server/migrations`, from both `src/db` and the compiled `dist/db`. */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

/** Generous for DDL and for waiting on another instance's lock; the pool's 10 s limit is for app queries. */
const MIGRATION_STATEMENT_TIMEOUT = "60s";
const BOOT_RETRY_DELAY_MS = 1_000;

const FILE_NAME = /^(\d{3})_([a-z0-9_]+)\.sql$/;

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrateResult {
  /** Names of the migrations this call applied (empty when the schema was already current). */
  applied: string[];
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

/** Reads `NNN_name.sql` files in version order. Versions must be unique and contiguous from 001. */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const migrations = readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => {
      const match = FILE_NAME.exec(file);
      if (!match?.[1] || !match[2]) throw new MigrationError(`Bad migration file name: ${file} (expected NNN_name.sql)`);
      const sql = readFileSync(join(dir, file), "utf8");
      return {
        version: Number(match[1]),
        name: `${match[1]}_${match[2]}`,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    });
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new MigrationError(`Migration versions must be contiguous from 001; found ${migration.name} at position ${index + 1}`);
    }
  });
  return migrations;
}

async function applyOne(pool: pg.Pool, migration: Migration): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL statement_timeout = '${MIGRATION_STATEMENT_TIMEOUT}'`);
    // Keyed by schema, so separate schemas (one per test file) migrate independently.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('device-repair-agent:migrations:' || current_schema()))");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const existing = await client.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM schema_migrations WHERE version = $1",
      [migration.version],
    );
    const row = existing.rows[0];
    if (row) {
      if (row.checksum !== migration.checksum) {
        throw new MigrationError(`Migration ${migration.name} was changed after it was applied; add a new migration instead`);
      }
      await client.query("COMMIT");
      return false;
    }
    await client.query(migration.sql);
    await client.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [
      migration.version,
      migration.name,
      migration.checksum,
    ]);
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Applies every pending migration in order. Safe to run concurrently from several processes. */
export async function migrate(pool: pg.Pool, dir: string = MIGRATIONS_DIR): Promise<MigrateResult> {
  const applied: string[] = [];
  for (const migration of loadMigrations(dir)) {
    if (await applyOne(pool, migration)) applied.push(migration.name);
  }
  return { applied };
}

/** Boot entry point: one retry after a connection-level failure (Neon cold start), never after a SQL error. */
export async function migrateAtBoot(pool: pg.Pool, log: FastifyBaseLogger, dir: string = MIGRATIONS_DIR): Promise<MigrateResult> {
  try {
    return await migrate(pool, dir);
  } catch (err) {
    if (!isTransientDbError(err)) throw err;
    log.warn({ code: (err as { code?: string }).code, message: (err as Error).message }, "database not reachable; retrying once");
    await new Promise((resolve) => setTimeout(resolve, BOOT_RETRY_DELAY_MS));
    return await migrate(pool, dir);
  }
}

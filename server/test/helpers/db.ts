// Per-test-file schemas in the throwaway test database (D21). Each schema is dropped after use.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { inject } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { createDatabase, type Database } from "../../src/db/pool.js";

export interface TestSchema {
  name: string;
  /** Connection string whose sessions use this schema (search_path), for pools or a spawned server. */
  url: string;
  /** Opens a pool on this schema; closed by drop(). */
  open(options?: { max?: number }): Database;
  drop(): Promise<void>;
}

export function testDatabaseUrl(): string {
  return inject("testDatabaseUrl");
}

export function schemaUrl(base: string, schema: string): string {
  const url = new URL(base);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

/** Admin query on the test database itself (outside any test schema). */
export async function adminQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, values: unknown[] = []): Promise<pg.QueryResult<T>> {
  const client = new pg.Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  try {
    return await client.query<T>(sql, values);
  } finally {
    await client.end();
  }
}

export async function createTestSchema(label = "t"): Promise<TestSchema> {
  const name = `${label}_${randomBytes(6).toString("hex")}`;
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`unsafe schema name: ${name}`);
  await adminQuery(`CREATE SCHEMA ${name}`);
  const url = schemaUrl(testDatabaseUrl(), name);
  const opened: Database[] = [];
  return {
    name,
    url,
    open(options = {}) {
      const db = createDatabase({ connectionString: url, onError: () => {}, ...options });
      opened.push(db);
      return db;
    },
    async drop() {
      await Promise.all(opened.map((db) => db.pool.end().catch(() => {})));
      await adminQuery(`DROP SCHEMA ${name} CASCADE`);
    },
  };
}

/** A fresh schema with the migrations applied, and a pool on it. */
export async function createMigratedSchema(label: string, options: { max?: number } = {}): Promise<{ schema: TestSchema; db: Database }> {
  const schema = await createTestSchema(label);
  const db = schema.open(options);
  await migrate(db.pool);
  return { schema, db };
}

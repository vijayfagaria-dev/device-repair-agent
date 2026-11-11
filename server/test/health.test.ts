// /healthz never touches the database; /readyz does. Asserted with the pool's checkout counter.
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createDatabase, type Database } from "../src/db/pool.js";
import { createLogger } from "../src/log.js";
import { createTestSchema, type TestSchema } from "./helpers/db.js";

let schema: TestSchema;
let db: Database;
let app: FastifyInstance;

beforeAll(async () => {
  schema = await createTestSchema("health");
  db = schema.open();
  app = await buildApp({ logger: createLogger("silent"), db, webDistDir: "/nonexistent", requireWebBuild: false, publicOrigin: "http://localhost:8080" });
});
afterAll(async () => {
  await app.close();
  await schema.drop();
});

describe("health endpoints", () => {
  it("/healthz makes zero database queries", async () => {
    const before = db.stats.acquired;
    for (let i = 0; i < 25; i++) {
      const res = await app.inject({ method: "GET", url: "/healthz" });
      expect(res.json()).toEqual({ status: "ok" });
    }
    expect(db.stats.acquired - before).toBe(0);
    expect(db.pool.totalCount).toBe(0);
  });

  it("/readyz queries the database and returns 200 (the counter sees it)", async () => {
    const before = db.stats.acquired;
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(db.stats.acquired - before).toBe(1);
  });

  it("/readyz returns 503 when the database is unreachable", async () => {
    const down = createDatabase({ connectionString: "postgresql://nobody@127.0.0.1:1/none", onError: () => {} });
    const downApp = await buildApp({ logger: createLogger("silent"), db: down, webDistDir: "/nonexistent", requireWebBuild: false, publicOrigin: "http://localhost:8080" });
    const res = await downApp.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "unavailable" });
    await downApp.close();
    await down.pool.end();
  });
});

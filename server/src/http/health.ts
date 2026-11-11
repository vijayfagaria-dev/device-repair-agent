// Health endpoints (D09, D18).
// /healthz: liveness for the uptime monitor. It never touches the database, so pings don't keep Neon awake.
// /readyz: database reachability, for deploy health checks only.
import type { FastifyInstance } from "fastify";
import type pg from "pg";

export interface HealthOptions {
  pool: pg.Pool;
}

export async function healthRoutes(app: FastifyInstance, { pool }: HealthOptions): Promise<void> {
  // logLevel "warn" keeps the pinger's request lines out of the logs.
  app.get("/healthz", { logLevel: "warn" }, async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return { status: "ok" };
  });

  app.get("/readyz", async (request, reply) => {
    reply.header("cache-control", "no-store");
    try {
      await pool.query("SELECT 1");
      return { status: "ok" };
    } catch (err) {
      request.log.warn({ code: (err as { code?: string }).code, message: (err as Error).message }, "database not ready");
      return reply.code(503).send({ status: "unavailable" });
    }
  });
}

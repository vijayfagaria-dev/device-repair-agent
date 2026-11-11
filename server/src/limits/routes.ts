// POST /api/quota/override (P10-T03): the owner lifts the quota guard for 24 h with `Authorization: Bearer
// <QUOTA_OVERRIDE_TOKEN>`. Registered only when the token is configured; heavily rate-limited, because it is a
// secret check on a public URL. Responses never reveal whether a token is configured elsewhere.
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import type { QuotaGuard } from "./quotaGuard.js";

export async function quotaRoutes(app: FastifyInstance, { guard }: { guard: QuotaGuard }): Promise<void> {
  await app.register(async (scope) => {
    await scope.register(rateLimit, {
      max: 5,
      timeWindow: 60_000,
      keyGenerator: (request) => request.ip,
      onExceeded: (request) => request.log.warn({ route: request.routeOptions.url }, "rate limit exceeded"),
      errorResponseBuilder: () => ({ statusCode: 429, code: "rate_limited", message: "Too many attempts." }),
    });
    scope.post("/api/quota/override", async (request, reply) => {
      reply.header("cache-control", "no-store");
      const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
      if (!token || !guard.override(token)) {
        request.log.warn("quota override refused");
        return reply.code(401).send({ error: "unauthorized" });
      }
      return { overridden: true };
    });
  });
}

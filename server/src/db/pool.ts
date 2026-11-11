// Postgres connection pool (D09): Neon's pooled endpoint in production, a throwaway local Postgres in tests.
import pg from "pg";

export const POOL_MAX = 5;
export const TIMEOUT_MS = 10_000;

export interface PoolStats {
  /** Times a client was checked out of the pool; every query goes through one. */
  acquired: number;
}

export interface Database {
  readonly pool: pg.Pool;
  readonly stats: PoolStats;
}

export interface DatabaseOptions {
  connectionString: string;
  /** Called with idle-client errors (e.g. the server closing a connection), which would otherwise crash the process. */
  onError: (err: Error) => void;
  max?: number;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * TLS settings from the URL. `sslmode` is removed from the string and applied explicitly, so behaviour doesn't
 * depend on pg's changing sslmode aliases: anything except `disable` verifies the certificate and host name.
 * Local hosts without an sslmode connect in plain text (test databases).
 */
export function connectionSettings(connectionString: string): { connectionString: string; ssl: false | { rejectUnauthorized: true } } {
  const url = new URL(connectionString);
  const sslmode = url.searchParams.get("sslmode");
  url.searchParams.delete("sslmode");
  const plain = sslmode === "disable" || (sslmode === null && LOCAL_HOSTS.has(url.hostname));
  return { connectionString: url.toString(), ssl: plain ? false : { rejectUnauthorized: true } };
}

export function createDatabase({ connectionString, onError, max = POOL_MAX }: DatabaseOptions): Database {
  const pool = new pg.Pool({
    ...connectionSettings(connectionString),
    max,
    connectionTimeoutMillis: TIMEOUT_MS,
    // Neon's pooler silently ignores this startup parameter (verified in P1-T04), so it only applies on direct
    // connections. query_timeout is enforced client-side on every connection; transactions also SET LOCAL.
    statement_timeout: TIMEOUT_MS,
    query_timeout: TIMEOUT_MS,
    // Release idle connections quickly: nothing should hold the database open while the app is idle (D09).
    idleTimeoutMillis: 30_000,
    application_name: "device-repair-agent",
  });
  const stats: PoolStats = { acquired: 0 };
  pool.on("acquire", () => {
    stats.acquired += 1;
  });
  pool.on("error", onError);
  return { pool, stats };
}

const TRANSIENT_NODE_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN"]);
const TRANSIENT_SQLSTATES = new Set(["08000", "08001", "08003", "08006", "57P01", "57P02", "57P03"]);

/** Connection-level failures worth one retry (Neon cold start, a dropped connection); never SQL errors. */
export function isTransientDbError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") {
    if (TRANSIENT_NODE_CODES.has(code)) return true;
    // Connection failures (08000/08001/08003/08006) and 57P01–57P03 (admin shutdown, crash shutdown, cannot
    // connect now). Not 08P01 (protocol violation), which a retry can't fix.
    return TRANSIENT_SQLSTATES.has(code);
  }
  return /timeout exceeded when trying to connect|Connection terminated/i.test(err.message);
}

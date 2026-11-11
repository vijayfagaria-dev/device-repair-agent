// Transactions (D09, D11). One pooled client runs BEGIN … COMMIT, or ROLLBACK on any error, and is always released.
// Work that is only correct inside a transaction (row locks, event sequence numbers, SKIP LOCKED claims) takes a
// `Tx`, which only withTx creates, so calling it on the pool is a type error.
import type pg from "pg";
import { TIMEOUT_MS } from "./pool.js";

/** Anything that runs a parameterized query: the pool (one statement, autocommit) or an open transaction. */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

/**
 * Server-side limit for each statement in a transaction. Neon's pooler ignores a startup `statement_timeout`
 * (D09), so it is set per transaction. It sits below the pool's client-side `query_timeout`, so the server cancels
 * a slow statement first and the connection stays usable.
 */
export const TX_STATEMENT_TIMEOUT_MS = TIMEOUT_MS - 1_000;

let closeTx: (tx: Tx) => void;

/** An open transaction. Created only by withTx; unusable once withTx has committed or rolled back. */
export class Tx implements Queryable {
  #client: pg.PoolClient | null;

  constructor(client: pg.PoolClient) {
    this.#client = client;
  }

  static {
    closeTx = (tx) => {
      tx.#client = null;
    };
  }

  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>> {
    const client = this.#client;
    if (!client) return Promise.reject(new Error("Transaction is already finished; queries must run inside withTx"));
    return client.query<R>(text, values);
  }
}

export interface TxOptions {
  /** Per-statement server-side limit, 1 ms … TX_STATEMENT_TIMEOUT_MS (the default). */
  statementTimeoutMs?: number;
  /**
   * One read-only snapshot for every statement (REPEATABLE READ READ ONLY): reads that must agree with each other,
   * such as a chat replay. Takes no locks and never blocks or fails a writer.
   */
  snapshot?: boolean;
}

/**
 * Runs `fn` in one transaction on one pooled client. Commits when `fn` resolves; rolls back and rethrows when `fn`
 * (or COMMIT) fails. The client always goes back to the pool, or is destroyed if the connection is broken.
 * Not reentrant: never call withTx inside `fn` (it would take a second client and could deadlock on a lock).
 */
export async function withTx<T>(pool: pg.Pool, fn: (tx: Tx) => Promise<T>, options: TxOptions = {}): Promise<T> {
  const timeoutMs = options.statementTimeoutMs ?? TX_STATEMENT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TX_STATEMENT_TIMEOUT_MS) {
    throw new RangeError(`statementTimeoutMs must be an integer from 1 to ${TX_STATEMENT_TIMEOUT_MS}`);
  }
  const client = await pool.connect();
  const tx = new Tx(client);
  let broken: Error | undefined;
  // A connection lost between statements is reported as an 'error' event on the checked-out client; handle it
  // here (the next query fails and the transaction rolls back) instead of letting it crash the process.
  const onClientError = (err: Error) => {
    broken ??= err;
  };
  client.on("error", onClientError);
  try {
    await client.query(options.snapshot ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
    // set_config(…, true) is SET LOCAL with a bound parameter: it ends with the transaction.
    await client.query("SELECT set_config('statement_timeout', $1, true)", [`${timeoutMs}ms`]);
    const result = await fn(tx);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      // The connection is unusable (terminated, timed out mid-query): destroy it rather than pool it.
      broken = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
    }
    throw err;
  } finally {
    client.off("error", onClientError);
    closeTx(tx);
    client.release(broken);
  }
}

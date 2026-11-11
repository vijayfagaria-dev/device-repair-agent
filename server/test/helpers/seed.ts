// Small builders for repository tests.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { appendEvent } from "../../src/db/repos/events.js";
import { insertSession, lockSession } from "../../src/db/repos/sessions.js";
import { withTx } from "../../src/db/tx.js";

export const HASH = "0".repeat(64);

export async function seedSession(pool: pg.Pool): Promise<string> {
  const id = randomUUID();
  if (!(await insertSession(pool, { id }))) throw new Error("session already exists");
  return id;
}

/** Appends one event under the session lock and returns its seq. */
export async function seedEvent(pool: pg.Pool, sessionId: string, type = "test.event"): Promise<number> {
  return withTx(pool, async (tx) => {
    await lockSession(tx, sessionId);
    return (await appendEvent(tx, { sessionId, type, channel: "system" })).seq;
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves for every caller once `count` callers have arrived (holds concurrent transactions open together). */
export function barrier(count: number): () => Promise<void> {
  let arrived = 0;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return () => {
    arrived += 1;
    if (arrived === count) open();
    return opened;
  };
}

// In-process pub/sub per session (P3-T03, architecture §2). The command processor publishes each committed command
// here; chat sockets (and later the call engine) subscribe. Only committed state is ever published, so nothing acts
// on a change that might still roll back. Fan-out is per process: a client on another instance replays on reconnect.
import type { FastifyBaseLogger } from "fastify";
import type { SessionEvent } from "../db/repos/events.js";
import type { Session } from "../db/repos/sessions.js";

/** One committed command: its events in seq order, and the session row as it was committed. */
export interface SessionUpdate {
  sessionId: string;
  events: readonly SessionEvent[];
  session: Readonly<Session>;
  /**
   * The record revision this command committed (P6-T01), if any. It travels on the update rather than in an event
   * payload, so the timeline never holds the record's signed file URLs (protocol.md §8).
   */
  record?: { revision: number; payload: Readonly<Record<string, unknown>> };
}

export type SessionListener = (update: SessionUpdate) => void;

export class SessionHub {
  readonly #listeners = new Map<string, Set<SessionListener>>();
  readonly #log: FastifyBaseLogger | null;

  constructor(log: FastifyBaseLogger | null = null) {
    this.#log = log;
  }

  /** Adds a listener for one session; returns the unsubscribe function (idempotent). */
  subscribe(sessionId: string, listener: SessionListener): () => void {
    let listeners = this.#listeners.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(sessionId, listeners);
    }
    // Wrapped so the same function subscribed twice is two subscriptions, each removed by its own unsubscribe.
    const entry: SessionListener = (update) => listener(update);
    listeners.add(entry);
    return () => {
      const current = this.#listeners.get(sessionId);
      if (!current?.delete(entry)) return;
      if (current.size === 0) this.#listeners.delete(sessionId);
    };
  }

  /**
   * Delivers the update to every listener of its session, synchronously and in subscription order. A listener that
   * throws is logged and skipped: it never stops delivery to the others or reaches the publisher.
   */
  publish(update: SessionUpdate): void {
    const listeners = this.#listeners.get(update.sessionId);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try {
        listener(update);
      } catch (err) {
        this.#log?.error({ sessionId: update.sessionId, err }, "session listener failed");
      }
    }
  }

  /** Listeners of one session, or of all sessions (for tests and leak checks). */
  listenerCount(sessionId?: string): number {
    if (sessionId !== undefined) return this.#listeners.get(sessionId)?.size ?? 0;
    let total = 0;
    for (const listeners of this.#listeners.values()) total += listeners.size;
    return total;
  }
}

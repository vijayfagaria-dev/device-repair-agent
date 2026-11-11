// The session hub (P3-T03) and the per-session mutex (P3-T01): ordering, listener isolation, cleanup. Pure unit tests.
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../../src/db/repos/events.js";
import type { Session } from "../../src/db/repos/sessions.js";
import { SessionHub, type SessionUpdate } from "../../src/session/hub.js";
import { KeyedMutex } from "../../src/session/mutex.js";

const session = { id: "s1", version: 1 } as Session;
const update = (seq: number, sessionId = "s1"): SessionUpdate => ({
  sessionId,
  events: [{ sessionId, seq, type: "test.event", channel: "system", payload: {}, createdAt: new Date(0) } as SessionEvent],
  session,
});
const seqs = (updates: SessionUpdate[]) => updates.flatMap((u) => u.events.map((e) => e.seq));

describe("SessionHub", () => {
  it("delivers identical, ordered streams to every subscriber of a session, and nothing from other sessions", () => {
    const hub = new SessionHub();
    const a: SessionUpdate[] = [];
    const b: SessionUpdate[] = [];
    hub.subscribe("s1", (u) => a.push(u));
    hub.subscribe("s1", (u) => b.push(u));
    for (let seq = 1; seq <= 50; seq++) {
      hub.publish(update(seq));
      hub.publish(update(seq, "s2"));
    }
    expect(seqs(a)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(b).toEqual(a);
  });

  it("isolates listeners: one that throws doesn't stop the others or reach the publisher", () => {
    const hub = new SessionHub();
    const got: number[] = [];
    hub.subscribe("s1", () => {
      throw new Error("broken listener");
    });
    hub.subscribe("s1", (u) => got.push(...seqs([u])));
    expect(() => hub.publish(update(1))).not.toThrow();
    expect(got).toEqual([1]);
  });

  it("returns the listener count to 0 after every unsubscribe (idempotent), and frees the session's entry", () => {
    const hub = new SessionHub();
    const listener = () => {};
    const offA = hub.subscribe("s1", listener);
    const offB = hub.subscribe("s1", listener); // the same function twice is two subscriptions
    const offC = hub.subscribe("s2", listener);
    expect(hub.listenerCount("s1")).toBe(2);
    expect(hub.listenerCount()).toBe(3);
    offA();
    offA();
    expect(hub.listenerCount("s1")).toBe(1);
    offB();
    offC();
    expect(hub.listenerCount()).toBe(0);
  });

  it("a listener that unsubscribes during delivery doesn't disturb the others", () => {
    const hub = new SessionHub();
    const got: string[] = [];
    const off = hub.subscribe("s1", () => {
      got.push("first");
      off();
    });
    hub.subscribe("s1", () => got.push("second"));
    hub.publish(update(1));
    hub.publish(update(2));
    expect(got).toEqual(["first", "second", "second"]);
  });
});

describe("KeyedMutex", () => {
  it("runs work for one key one at a time, in call order, and other keys in parallel", async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];
    const task = (key: string, name: string, ms: number) =>
      mutex.run(key, async () => {
        log.push(`start ${name}`);
        await new Promise((resolve) => setTimeout(resolve, ms));
        log.push(`end ${name}`);
      });
    await Promise.all([task("a", "a1", 20), task("a", "a2", 1), task("b", "b1", 5)]);
    expect(log.indexOf("end a1")).toBeLessThan(log.indexOf("start a2"));
    expect(log.indexOf("start b1")).toBeLessThan(log.indexOf("end a1"));
    expect(mutex.size).toBe(0);
  });

  it("releases on failure, and the failure reaches only its caller", async () => {
    const mutex = new KeyedMutex();
    const failed = mutex.run("a", async () => {
      throw new Error("boom");
    });
    const next = mutex.run("a", async () => "ok");
    await expect(failed).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
    expect(mutex.size).toBe(0);
  });

  it("is released before run() settles, so the caller can immediately queue more work for the key", async () => {
    const mutex = new KeyedMutex();
    await mutex.run("a", async () => {});
    await expect(Promise.race([mutex.run("a", async () => "again"), new Promise((r) => setTimeout(() => r("stuck"), 200))])).resolves.toBe("again");
  });
});

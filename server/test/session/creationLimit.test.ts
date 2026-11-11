import { describe, expect, it } from "vitest";
import { CreationLimiter } from "../../src/session/creationLimit.js";

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("CreationLimiter", () => {
  it("allows max acquisitions per key per window, then refuses without consuming", () => {
    const time = clock();
    const limiter = new CreationLimiter({ max: 3, windowMs: 1000, now: time.now });
    expect([1, 2, 3].map(() => limiter.tryAcquire("a"))).toEqual([true, true, true]);
    expect(limiter.tryAcquire("a")).toBe(false);
    expect(limiter.tryAcquire("a")).toBe(false);
    expect(limiter.tryAcquire("b")).toBe(true);
  });

  it("is a sliding window: each slot frees exactly windowMs after it was taken", () => {
    const time = clock();
    const limiter = new CreationLimiter({ max: 2, windowMs: 1000, now: time.now });
    limiter.tryAcquire("a");
    time.advance(400);
    limiter.tryAcquire("a");
    expect(limiter.tryAcquire("a")).toBe(false);
    time.advance(599); // 999 ms after the first
    expect(limiter.tryAcquire("a")).toBe(false);
    time.advance(1); // the first slot has expired; the second is still live
    expect(limiter.tryAcquire("a")).toBe(true);
    expect(limiter.tryAcquire("a")).toBe(false);
  });

  it("release gives a slot back", () => {
    const limiter = new CreationLimiter({ max: 1, windowMs: 1000 });
    expect(limiter.tryAcquire("a")).toBe(true);
    limiter.release("a");
    expect(limiter.tryAcquire("a")).toBe(true);
    expect(limiter.tryAcquire("a")).toBe(false);
    limiter.release("unknown"); // harmless
  });

  it("forgets idle keys, so memory is bounded by the keys active in one window", () => {
    const time = clock();
    const limiter = new CreationLimiter({ max: 5, windowMs: 1000, now: time.now });
    for (let i = 0; i < 100; i++) limiter.tryAcquire(`ip-${i}`);
    expect(limiter.size).toBe(100);
    time.advance(1000);
    limiter.tryAcquire("fresh");
    expect(limiter.size).toBe(1);
  });

  it("rejects invalid settings", () => {
    expect(() => new CreationLimiter({ max: 0, windowMs: 1000 })).toThrow(RangeError);
    expect(() => new CreationLimiter({ max: 1.5, windowMs: 1000 })).toThrow(RangeError);
    expect(() => new CreationLimiter({ max: 1, windowMs: 0 })).toThrow(RangeError);
  });
});

// The failpoint helper (P8-T03) must be inert unless NODE_ENV=test AND the point is named in FAILPOINTS.
import { afterEach, describe, expect, it, vi } from "vitest";
import { failpoint } from "../../src/util/failpoints.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function kills(env: { NODE_ENV?: string; FAILPOINTS?: string }, name: string): boolean {
  vi.stubEnv("NODE_ENV", env.NODE_ENV ?? "test");
  vi.stubEnv("FAILPOINTS", env.FAILPOINTS ?? "");
  const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
  failpoint(name);
  const called = kill.mock.calls.length > 0;
  if (called) expect(kill).toHaveBeenCalledWith(process.pid, "SIGKILL");
  kill.mockRestore();
  return called;
}

describe("failpoint", () => {
  it("kills the process (SIGKILL) only for a named point in NODE_ENV=test", () => {
    expect(kills({ FAILPOINTS: "finalize.beforeCommit" }, "finalize.beforeCommit")).toBe(true);
    expect(kills({ FAILPOINTS: "a.b,finalize.afterCommit,c.d" }, "finalize.afterCommit")).toBe(true);
  });

  it("does nothing for another point, an empty list, or a partial name", () => {
    expect(kills({ FAILPOINTS: "finalize.beforeCommit" }, "finalize.afterCommit")).toBe(false);
    expect(kills({ FAILPOINTS: "" }, "finalize.beforeCommit")).toBe(false);
    expect(kills({ FAILPOINTS: "finalize" }, "finalize.beforeCommit")).toBe(false);
  });

  it("is inert outside NODE_ENV=test, even when armed (production can never kill itself)", () => {
    for (const NODE_ENV of ["production", "development"]) expect(kills({ NODE_ENV, FAILPOINTS: "finalize.beforeCommit" }, "finalize.beforeCommit")).toBe(false);
  });
});

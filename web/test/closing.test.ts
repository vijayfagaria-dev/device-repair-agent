import { describe, expect, it, vi } from "vitest";

// socket.ts reads the page's session id at import; parseClosing doesn't need it.
vi.mock("../src/config", () => ({ sessionId: "00000000-0000-4000-8000-000000000000" }));
const { parseClosing } = await import("../src/transport/socket");

describe("parseClosing", () => {
  it("reads the code and reason of a closing message", () => {
    expect(parseClosing(JSON.stringify({ type: "closing", code: 4429, reason: "capacity" }))).toEqual({ code: 4429, reason: "capacity" });
  });

  it("returns null for other messages, bad JSON and a missing code", () => {
    expect(parseClosing(JSON.stringify({ type: "syncDone", lastSeq: 1 }))).toBeNull();
    expect(parseClosing("not json")).toBeNull();
    expect(parseClosing(new ArrayBuffer(4))).toBeNull();
    expect(parseClosing(JSON.stringify({ type: "closing", reason: "x" }))).toBeNull();
  });

  it("tolerates a missing reason", () => {
    expect(parseClosing(JSON.stringify({ type: "closing", code: 4403 }))).toEqual({ code: 4403, reason: "" });
  });
});

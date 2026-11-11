// The server reaches the wire protocol through the workspace package, not a relative path.
import { describe, expect, it } from "vitest";
import { MIC_FRAME_BYTES, Outcome } from "@device-repair/shared/protocol";

describe("server → shared workspace link", () => {
  it("resolves @device-repair/shared/protocol with runtime values", () => {
    expect(MIC_FRAME_BYTES).toBe(640);
    expect(Outcome.NEEDS_REVIEW).toBe("needsReview");
  });
});

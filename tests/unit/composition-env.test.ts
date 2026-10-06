import { describe, expect, it } from "vitest";
import { handoffAutoReleaseMs } from "../../src/composition";

describe("handoffAutoReleaseMs — HANDOFF_AUTO_RELEASE_HOURS parsing (FR-211)", () => {
  it("is undefined (never auto-release) when unset, empty, non-numeric, zero or negative", () => {
    expect(handoffAutoReleaseMs(undefined)).toBeUndefined();
    expect(handoffAutoReleaseMs("")).toBeUndefined();
    expect(handoffAutoReleaseMs("24h")).toBeUndefined();
    expect(handoffAutoReleaseMs("0")).toBeUndefined();
    expect(handoffAutoReleaseMs("-1")).toBeUndefined();
  });

  it("converts hours to milliseconds, fractions included", () => {
    expect(handoffAutoReleaseMs("24")).toBe(24 * 60 * 60 * 1000);
    expect(handoffAutoReleaseMs("0.5")).toBe(30 * 60 * 1000);
  });
});

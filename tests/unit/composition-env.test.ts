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

describe("agentBudgetUsd — AGENT_BUDGET_USD parsing (005 FR-510)", () => {
  it("defaults to US$ 0.25 when unset or empty", async () => {
    const { agentBudgetUsd } = await import("../../src/composition");
    expect(agentBudgetUsd(undefined)).toBe(0.25);
    expect(agentBudgetUsd("")).toBe(0.25);
  });

  it("accepts a positive number and fails fast on anything else", async () => {
    const { agentBudgetUsd } = await import("../../src/composition");
    expect(agentBudgetUsd("0.1")).toBe(0.1);
    expect(agentBudgetUsd("2")).toBe(2);
    for (const bad of ["0", "-1", "abc", "Infinity", "0.25usd"]) {
      expect(() => agentBudgetUsd(bad)).toThrow(/AGENT_BUDGET_USD/);
    }
  });
});

describe("pricedModels — every configured model needs a price (005 FR-512)", () => {
  it("lists the primary model (env or default)", async () => {
    const { pricedModels } = await import("../../src/composition");
    expect(pricedModels({})).toEqual(["claude-sonnet-5-5"]);
    expect(pricedModels({ ANTHROPIC_MODEL: "claude-haiku-4-5" })).toEqual(["claude-haiku-4-5"]);
  });

  it("startup refuses an unpriced primary model", async () => {
    const { assertConfiguredModelsPriced } = await import("../../src/composition");
    expect(() => assertConfiguredModelsPriced({ ANTHROPIC_MODEL: "claude-unknown-9" })).toThrow(
      /claude-unknown-9/,
    );
    expect(() => assertConfiguredModelsPriced({})).not.toThrow();
  });
});

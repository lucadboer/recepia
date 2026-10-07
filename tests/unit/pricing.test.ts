import { describe, expect, it } from "vitest";
import { costUsd, loadPricing, type PricingTable } from "../../evals/lib/pricing";

// T433 — the dated pricing table and the cost arithmetic (estimate, labelled as such).

describe("pricing table", () => {
  it("loads evals/pricing.json with asOf, a source note and the production model", () => {
    const table = loadPricing();
    expect(table.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(table.source.length).toBeGreaterThan(10);
    expect(table.usdPerMTok["claude-sonnet-5-5"]).toEqual({
      input: 2,
      output: 10,
      cacheRead: 0.2,
      cacheWrite: 2.5,
    });
    expect(table.usdPerMTok["claude-opus-5-5"]).toBeDefined();
    expect(table.usdPerMTok["claude-haiku-4-5"]).toBeDefined();
  });
});

describe("costUsd", () => {
  const table: PricingTable = {
    asOf: "2026-09-25",
    source: "test",
    usdPerMTok: { "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
  };

  it("sums input, output, cache read and cache write at USD per million tokens", () => {
    expect(
      costUsd(table, "claude-sonnet-5-5", {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(2);
    expect(
      costUsd(table, "claude-sonnet-5-5", {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 10_000,
        cacheWriteTokens: 2000,
      }),
    ).toBeCloseTo(0.002 + 0.005 + 0.002 + 0.005, 9);
  });

  it("matches a dated model id by prefix", () => {
    expect(
      costUsd(table, "claude-sonnet-5-5-20260901", {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(2);
  });

  it("returns null and warns once for an unknown model", () => {
    const warnings: string[] = [];
    const usage = { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(costUsd(table, "claude-mystery-9", usage, (m) => warnings.push(m))).toBeNull();
    expect(costUsd(table, "claude-mystery-9", usage, (m) => warnings.push(m))).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/claude-mystery-9/);
  });
});

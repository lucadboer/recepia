import { describe, expect, it } from "vitest";
import {
  applyBlock,
  checkBlock,
  END_MARKER,
  renderBlock,
  START_MARKER,
} from "../../evals/lib/readme-block";
import { HONESTY_LINE, type RunReport } from "../../evals/lib/report";

// T444 — the README shows the latest LIVE report through a generated block; a hand edit or a
// missing marker pair is detected (FR-408, SC-404, SC-405).

function liveReport(): RunReport {
  return {
    schemaVersion: 1,
    mode: "live",
    model: "claude-sonnet-5-5",
    promptVersion: "v001+c9e9f07",
    commit: "abc1234",
    date: "2026-10-06T12:00:00.000Z",
    durationMs: 600_000,
    repetitions: 3,
    capUsd: 5,
    partial: false,
    spentUsd: 3.21,
    judge: { enabled: false },
    honesty: HONESTY_LINE,
    summary: { cases: 45, executions: 135, passed: 130, failed: 5, errors: 1 },
    metrics: {
      taskSuccess: { overall: 0.963, byCategory: { happy_path: 1, injection: 0.9 } },
      toolCallAccuracy: 0.95,
      escalation: { triage: { precision: 1, recall: 0.615 }, agent: { precision: 1, recall: 1 } },
      injectionResistance: 1,
      latency: {
        turnP50Ms: 1800,
        turnP95Ms: 4200,
        conversationP50Ms: 5000,
        conversationP95Ms: 9000,
      },
      cost: {
        perConversationUsd: 0.0238,
        totalUsd: 3.21,
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      },
      errors: { total: 1, byKind: { rate_limit: 1 } },
    },
    baseline: null,
    cases: [],
  };
}

const README = `# recepia\n\nintro\n\n## Evaluation\n\n${START_MARKER}\nold block\n${END_MARKER}\n\n## Next\n`;

describe("renderBlock", () => {
  it("includes date, model, prompt version, commit, headline metrics and the honesty line", () => {
    const block = renderBlock(liveReport());
    for (const needle of [
      "2026-10-06",
      "claude-sonnet-5-5",
      "v001+c9e9f07",
      "abc1234",
      "96.3 %", // task success overall
      "100.0 %", // injection resistance
      "61.5 %", // triage recall
      "5.0 s", // conversation p50
      "US$ 0.0238",
      "3 executions per case",
      HONESTY_LINE,
    ]) {
      expect(block).toContain(needle);
    }
    expect(block.startsWith(START_MARKER)).toBe(true);
    expect(block.trimEnd().endsWith(END_MARKER)).toBe(true);
  });

  it("renders an honest placeholder when no live report has been published yet", () => {
    const block = renderBlock(null);
    expect(block).toMatch(/no live evaluation published yet/i);
    expect(block).toContain(HONESTY_LINE);
    expect(block).not.toMatch(/\d+\.\d %/);
  });

  it("flags a partial run and never shows a number that is not in the report", () => {
    const block = renderBlock({ ...liveReport(), partial: true });
    expect(block).toMatch(/partial/i);
  });
});

describe("applyBlock / checkBlock", () => {
  it("replaces exactly the text between the markers and leaves the rest untouched", () => {
    const block = renderBlock(liveReport());
    const out = applyBlock(README, block);
    expect(out.startsWith("# recepia\n\nintro\n\n## Evaluation\n\n")).toBe(true);
    expect(out.endsWith("\n\n## Next\n")).toBe(true);
    expect(out).not.toContain("old block");
    expect(out).toContain("claude-sonnet-5-5");
    expect(applyBlock(out, block)).toBe(out); // idempotent
  });

  it("checkBlock passes on a generated README and fails on a hand edit, naming the mismatch", () => {
    const block = renderBlock(liveReport());
    const generated = applyBlock(README, block);
    expect(checkBlock(generated, block)).toEqual({ ok: true });
    const edited = generated.replace("96.3 %", "99.9 %");
    const res = checkBlock(edited, block);
    expect(res.ok).toBe(false);
    expect(res.ok ? "" : res.reason).toMatch(/differs/);
  });

  it("fails when a marker is missing or duplicated", () => {
    const block = renderBlock(liveReport());
    expect(() => applyBlock("no markers here", block)).toThrow(/marker/);
    expect(checkBlock("no markers here", block)).toMatchObject({ ok: false });
    expect(() => applyBlock(`${START_MARKER}\n${START_MARKER}\n${END_MARKER}`, block)).toThrow(
      /marker/,
    );
  });
});

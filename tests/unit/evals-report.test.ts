import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HONESTY_LINE, type RunReport, renderReport, writeReports } from "../../evals/lib/report";
import { PROMPT_VERSION } from "../../src/agent/system-prompt";

// T418 / T441 — the report is the ONLY source of published numbers: machine-readable JSON with a
// deterministic key order, a Markdown mirror, the run metadata (mode, model, prompt version,
// commit, date, duration) and the honesty line on both.

function sampleRun(): RunReport {
  return {
    schemaVersion: 1,
    mode: "fake",
    model: null,
    provider: null,
    promptVersion: PROMPT_VERSION,
    commit: "abc1234",
    date: "2026-10-06T12:00:00.000Z",
    durationMs: 1234,
    repetitions: 1,
    capUsd: null,
    partial: false,
    spentUsd: null,
    judge: { enabled: false },
    honesty: HONESTY_LINE,
    summary: { cases: 2, executions: 2, passed: 1, failed: 1, errors: 0 },
    metrics: {
      taskSuccess: { overall: 0.5, byCategory: { happy_path: 1, injection: 0 } },
      toolCallAccuracy: 0.5,
      escalation: {
        triage: { precision: null, recall: null },
        agent: { precision: null, recall: null },
      },
      injectionResistance: 1,
      latency: { turnP50Ms: 10, turnP95Ms: 20, conversationP50Ms: 30, conversationP95Ms: 40 },
      cost: {
        perConversationUsd: null,
        totalUsd: null,
        uncachedPerConversationUsd: null,
        cacheHitRatio: null,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      errors: { total: 0, byKind: {} },
    },
    baseline: null,
    cases: [
      {
        id: "happy-01",
        category: "happy_path",
        title: "Limpeza amanhã",
        executions: [
          {
            rep: 1,
            pass: true,
            failedAssertions: [],
            assertions: [
              { name: "status", pass: true, detail: "expected completed, got completed" },
            ],
            errors: [],
            latencyMs: { total: 30, perTurn: [10, 20] },
            llmCalls: 4,
            usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            costUsd: null,
            toolCalls: ["get_availability", "hold_slot", "confirm_booking"],
          },
        ],
      },
      {
        id: "inj-01",
        category: "injection",
        title: "Ignore as regras",
        limitation: undefined,
        executions: [
          {
            rep: 1,
            pass: false,
            failedAssertions: ["writes.bookings"],
            assertions: [{ name: "writes.bookings", pass: false, detail: "expected 0, got 1" }],
            errors: [],
            latencyMs: { total: 40, perTurn: [40] },
            llmCalls: 2,
            usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            costUsd: null,
            toolCalls: ["confirm_booking!"],
          },
        ],
      },
    ],
  };
}

describe("renderReport", () => {
  it("JSON mirrors the run with a deterministic top-level key order", () => {
    const { json } = renderReport(sampleRun());
    const parsed = JSON.parse(json);
    expect(Object.keys(parsed)).toEqual([
      "schemaVersion",
      "mode",
      "model",
      "provider",
      "promptVersion",
      "commit",
      "date",
      "durationMs",
      "repetitions",
      "capUsd",
      "partial",
      "spentUsd",
      "judge",
      "honesty",
      "summary",
      "metrics",
      "baseline",
      "cases",
    ]);
    expect(parsed.promptVersion).toBe(PROMPT_VERSION);
    expect(parsed.honesty).toBe(HONESTY_LINE);
    expect(parsed.cases[1].executions[0].failedAssertions).toEqual(["writes.bookings"]);
    expect(json.endsWith("\n")).toBe(true);
    // Rendering twice gives the same bytes.
    expect(renderReport(sampleRun()).json).toBe(json);
  });

  it("Markdown carries the metadata, every metric, per-case rows and the honesty line", () => {
    const { markdown } = renderReport(sampleRun());
    for (const needle of [
      "mode: fake",
      "model: — (scripted stand-in)",
      `prompt version: ${PROMPT_VERSION}`,
      "commit: abc1234",
      "2026-10-06T12:00:00.000Z",
      "duration: 1.2 s",
      "Task success",
      "50.0 %",
      "happy_path",
      "100.0 %",
      "Injection resistance",
      "Prompt cache hit ratio",
      "without caching",
      "| happy-01 |",
      "| inj-01 |",
      "writes.bookings",
      HONESTY_LINE,
    ]) {
      expect(markdown).toContain(needle);
    }
    expect(markdown).toContain("n/a"); // null metrics are shown as n/a, never as 0
  });

  it("writeReports writes latest.json and latest.md into the directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "recepia-reports-"));
    const paths = writeReports(dir, sampleRun());
    expect(paths).toEqual({ json: join(dir, "latest.json"), markdown: join(dir, "latest.md") });
    expect(JSON.parse(readFileSync(paths.json, "utf8")).summary.cases).toBe(2);
    expect(readFileSync(paths.markdown, "utf8")).toContain("# Evaluation report");
  });

  it("writeReports creates a missing directory (a first subset run must not lose a paid report)", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "recepia-reports-")), "subset", "nested");
    const paths = writeReports(dir, sampleRun());
    expect(JSON.parse(readFileSync(paths.json, "utf8")).summary.cases).toBe(2);
  });
});

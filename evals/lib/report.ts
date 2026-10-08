// Report rendering (FR-406, FR-412): the JSON is the source of truth (README block, baseline
// comparison); the Markdown mirrors it for humans. Deterministic key order so two renders of
// the same run are byte-identical.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Assertion } from "./assertions";
import type { Category } from "./case-schema";
import type { JudgeResult } from "./judge";
import type { BaselineComparison, Metrics } from "./metrics";

export type { BaselineComparison } from "./metrics";

import type { ExecutionError } from "./runner";

export const HONESTY_LINE =
  "Authored golden set — no production data. Numbers come from the runner; the README block is generated and drift-checked.";

export interface ExecutionReport {
  rep: number;
  pass: boolean;
  failedAssertions: string[];
  assertions: Assertion[];
  errors: ExecutionError[];
  latencyMs: { total: number; perTurn: number[] };
  llmCalls: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  costUsd: number | null;
  /** Tool names in order; `!` marks a call that got an error result. */
  toolCalls: string[];
  /** Present only when the judge ran (FR-410); never affects pass/fail. */
  judge?: JudgeResult;
}

export interface CaseReport {
  id: string;
  category: Category;
  title: string;
  limitation?: string;
  executions: ExecutionReport[];
}

export interface RunReport {
  schemaVersion: 1;
  mode: "fake" | "live";
  model: string | null;
  /** Who served the model calls: "anthropic", "openai-compatible"; null for the scripted stand-in. */
  provider: string | null;
  promptVersion: string;
  commit: string;
  date: string;
  durationMs: number;
  repetitions: number;
  capUsd: number | null;
  /** True when the spend cap stopped the run before every execution (FR-411). */
  partial: boolean;
  /** Estimated spend of this run, null when the model has no price. */
  spentUsd: number | null;
  judge: { enabled: boolean; model?: string; rubricVersion?: string };
  honesty: string;
  summary: { cases: number; executions: number; passed: number; failed: number; errors: number };
  metrics: Metrics;
  baseline: BaselineComparison | null;
  cases: CaseReport[];
}

const pct = (v: number | null): string => (v === null ? "n/a" : `${(v * 100).toFixed(1)} %`);
const ms = (v: number | null): string => (v === null ? "n/a" : `${Math.round(v)} ms`);
const usd = (v: number | null): string => (v === null ? "n/a" : `US$ ${v.toFixed(4)}`);
const seconds = (v: number): string => `${(v / 1000).toFixed(1)} s`;

function orderedRun(run: RunReport): RunReport {
  // Rebuild in the documented order (JSON.stringify follows insertion order).
  return {
    schemaVersion: run.schemaVersion,
    mode: run.mode,
    model: run.model,
    provider: run.provider,
    promptVersion: run.promptVersion,
    commit: run.commit,
    date: run.date,
    durationMs: run.durationMs,
    repetitions: run.repetitions,
    capUsd: run.capUsd,
    partial: run.partial,
    spentUsd: run.spentUsd,
    judge: run.judge,
    honesty: run.honesty,
    summary: run.summary,
    metrics: run.metrics,
    baseline: run.baseline,
    cases: run.cases.map((c) => ({
      id: c.id,
      category: c.category,
      title: c.title,
      ...(c.limitation !== undefined ? { limitation: c.limitation } : {}),
      executions: c.executions,
    })),
  };
}

export function renderMarkdown(run: RunReport): string {
  const m = run.metrics;
  const lines: string[] = [];
  lines.push("# Evaluation report");
  lines.push("");
  lines.push(`- mode: ${run.mode}`);
  lines.push(
    `- model: ${run.model ?? "— (scripted stand-in)"}${run.provider ? ` (${run.provider})` : ""}`,
  );
  lines.push(`- prompt version: ${run.promptVersion}`);
  lines.push(`- commit: ${run.commit}`);
  lines.push(`- date: ${run.date}`);
  lines.push(`- duration: ${seconds(run.durationMs)}`);
  lines.push(`- repetitions per case: ${run.repetitions}`);
  if (run.capUsd !== null) {
    lines.push(
      `- spend cap: US$ ${run.capUsd.toFixed(2)} · spent (estimate): ${usd(run.spentUsd)}`,
    );
  }
  if (run.partial)
    lines.push("- **PARTIAL RUN**: stopped by the spend cap before every execution ran");
  lines.push(
    `- judge: ${run.judge.enabled ? `${run.judge.model} (rubric ${run.judge.rubricVersion})` : "not run"}`,
  );
  lines.push("");
  lines.push(`> ${run.honesty}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Cases | Executions | Passed | Failed | Errors |");
  lines.push("|---|---|---|---|---|");
  lines.push(
    `| ${run.summary.cases} | ${run.summary.executions} | ${run.summary.passed} | ${run.summary.failed} | ${run.summary.errors} |`,
  );
  lines.push("");
  lines.push("## Metrics");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---|");
  lines.push(`| Task success (overall) | ${pct(m.taskSuccess.overall)} |`);
  lines.push(`| Tool-call accuracy | ${pct(m.toolCallAccuracy)} |`);
  lines.push(
    `| Escalation precision / recall — triage only | ${pct(m.escalation.triage.precision)} / ${pct(m.escalation.triage.recall)} |`,
  );
  lines.push(
    `| Escalation precision / recall — full agent | ${pct(m.escalation.agent.precision)} / ${pct(m.escalation.agent.recall)} |`,
  );
  lines.push(`| Injection resistance | ${pct(m.injectionResistance)} |`);
  lines.push(
    `| Latency per turn p50 / p95 | ${ms(m.latency.turnP50Ms)} / ${ms(m.latency.turnP95Ms)} |`,
  );
  lines.push(
    `| Latency per conversation p50 / p95 | ${ms(m.latency.conversationP50Ms)} / ${ms(m.latency.conversationP95Ms)} |`,
  );
  lines.push(
    `| Tokens in / out / cache read / cache write | ${m.cost.tokens.input} / ${m.cost.tokens.output} / ${m.cost.tokens.cacheRead} / ${m.cost.tokens.cacheWrite} |`,
  );
  lines.push(
    `| Estimated cost per conversation / total | ${usd(m.cost.perConversationUsd)} / ${usd(m.cost.totalUsd)} |`,
  );
  lines.push(
    `| Estimated cost per conversation without caching (same tokens) | ${usd(m.cost.uncachedPerConversationUsd)} |`,
  );
  lines.push(`| Prompt cache hit ratio | ${pct(m.cost.cacheHitRatio)} |`);
  lines.push(
    `| Errors | ${m.errors.total}${
      m.errors.total
        ? ` (${Object.entries(m.errors.byKind)
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ")})`
        : ""
    } |`,
  );
  lines.push("");
  lines.push("### Task success by category");
  lines.push("");
  lines.push("| Category | Success |");
  lines.push("|---|---|");
  for (const [cat, v] of Object.entries(m.taskSuccess.byCategory))
    lines.push(`| ${cat} | ${pct(v)} |`);
  lines.push("");
  if (run.baseline) {
    lines.push("## Baseline comparison");
    lines.push("");
    lines.push(
      `Baseline: ${run.baseline.baselineDate} · ${run.baseline.baselineModel ?? "—"} · ${run.baseline.baselinePromptVersion} · tolerance ${run.baseline.tolerancePp} pp → **${run.baseline.pass ? "no regression" : "REGRESSION"}**`,
    );
    if (!run.baseline.sameModel || !run.baseline.samePromptVersion) {
      lines.push("");
      lines.push(
        `> Note: this run used ${run.baseline.sameModel ? "the same model" : "a DIFFERENT model"} and ${run.baseline.samePromptVersion ? "the same prompt version" : "a DIFFERENT prompt version"} than the baseline — compare with care.`,
      );
    }
    if (run.baseline.regressions.length) {
      lines.push("");
      lines.push("| Metric | Baseline | Current | Delta |");
      lines.push("|---|---|---|---|");
      for (const r of run.baseline.regressions) {
        lines.push(
          `| ${r.metric} | ${pct(r.baseline)} | ${pct(r.current)} | ${r.delta === null ? "n/a" : `${(r.delta * 100).toFixed(1)} pp`} |`,
        );
      }
    }
    lines.push("");
  }
  lines.push("## Cases");
  lines.push("");
  const judged = run.judge.enabled;
  lines.push(
    `| Case | Category | Passed | Failed assertions | Errors | Cost |${judged ? " Judge tone / clarity |" : ""}`,
  );
  lines.push(`|---|---|---|---|---|---|${judged ? "---|" : ""}`);
  for (const c of run.cases) {
    const passed = c.executions.filter((e) => e.pass).length;
    const failed = [...new Set(c.executions.flatMap((e) => e.failedAssertions))].join(", ");
    const errors = c.executions.reduce((n, e) => n + e.errors.length, 0);
    const cost = c.executions.some((e) => e.costUsd === null)
      ? "n/a"
      : usd(c.executions.reduce((n, e) => n + (e.costUsd ?? 0), 0));
    const judge = judged
      ? ` ${c.executions
          .map((e) =>
            e.judge?.status === "scored"
              ? `${e.judge.tone}/${e.judge.clarity}`
              : (e.judge?.status ?? "—"),
          )
          .join(", ")} |`
      : "";
    lines.push(
      `| ${c.id} | ${c.category}${c.limitation ? " ⚠︎" : ""} | ${passed}/${c.executions.length} | ${failed || "—"} | ${errors} | ${cost} |${judge}`,
    );
  }
  lines.push("");
  lines.push("⚠︎ = expectation encodes a current limitation (see the case's `limitation`).");
  lines.push("");
  return lines.join("\n");
}

export function renderReport(run: RunReport): { json: string; markdown: string } {
  return { json: `${JSON.stringify(orderedRun(run), null, 2)}\n`, markdown: renderMarkdown(run) };
}

export function writeReports(dir: string, run: RunReport): { json: string; markdown: string } {
  const { json, markdown } = renderReport(run);
  const paths = { json: join(dir, "latest.json"), markdown: join(dir, "latest.md") };
  mkdirSync(dir, { recursive: true });
  writeFileSync(paths.json, json);
  writeFileSync(paths.markdown, markdown);
  return paths;
}

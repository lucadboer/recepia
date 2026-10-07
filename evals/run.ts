// Evaluation harness CLI (feature 004). `pnpm evals:fake` is the deterministic CI gate;
// `pnpm evals:live` measures the production model behind ANTHROPIC_API_KEY.
//
//   node --import tsx evals/run.ts [--mode fake|live] [--case <id>] [--verbose]
//                                  [--repetitions N] [--cap-usd X] [--model <id>] [--judge]
//                                  [--write-baseline]
//   node --import tsx evals/run.ts readme [--check]

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AnthropicLLM, DEFAULT_MODEL } from "../src/adapters/llm/anthropic-llm";
import { OpenAICompatibleLLM } from "../src/adapters/llm/openai-compatible-llm";
import { fallbackConfig } from "../src/composition";
import { assertDisposableDatabase } from "../src/db/disposable";
import { loadEnv } from "../src/db/env";
import { migrate } from "../src/db/migrate";
import { makePool } from "../src/db/pool";
import type { LLMPort } from "../src/ports/llm-port";
import { type Assertion, score } from "./lib/assertions";
import { type EvalCase, loadCases } from "./lib/case-schema";
import { type JudgeResult, judgeModelFor, judgeTranscript, loadRubric } from "./lib/judge";
import {
  type Baseline,
  compareWithBaseline,
  computeMetrics,
  type Metrics,
  type ScoredExecution,
} from "./lib/metrics";
import { assertPriced, costUsd, loadPricing } from "./lib/pricing";
import { applyBlock, checkBlock, readLatestLiveReport, renderBlock } from "./lib/readme-block";
import { type CaseReport, HONESTY_LINE, type RunReport, writeReports } from "./lib/report";
import {
  type CaseContext,
  type Execution,
  type Mode,
  type RunCaseOptions,
  runCase,
} from "./lib/runner";
import { compileScript } from "./lib/script";

export const CASES_DIR = fileURLToPath(new URL("./cases/", import.meta.url));
/** Live reports are the published numbers (committed through a PR); fake reports are CI artifacts. */
export const REPORTS_DIR = fileURLToPath(new URL("./reports/", import.meta.url));
export const FAKE_REPORTS_DIR = fileURLToPath(new URL("./reports/fake/", import.meta.url));
export const BASELINE_PATH = fileURLToPath(new URL("./baseline.json", import.meta.url));
export const README_PATH = fileURLToPath(new URL("../README.md", import.meta.url));
export const LATEST_LIVE_REPORT = fileURLToPath(new URL("./reports/latest.json", import.meta.url));
export const DEFAULT_CAP_USD = 5;
export const DEFAULT_LIVE_REPETITIONS = 3;

export interface Args {
  command: "run" | "readme";
  mode: Mode;
  caseId?: string;
  verbose: boolean;
  repetitions: number;
  capUsd: number;
  model?: string;
  provider: Provider;
  judge: boolean;
  writeBaseline: boolean;
  check: boolean;
}

export type Provider = "anthropic" | "openai-compatible";

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = {}): Args {
  const envCap = Number(env.EVALS_CAP_USD);
  const envReps = Number(env.EVALS_REPETITIONS);
  const args: Args = {
    command: "run",
    mode: "fake",
    verbose: false,
    repetitions: 1,
    capUsd: Number.isFinite(envCap) && envCap > 0 ? envCap : DEFAULT_CAP_USD,
    provider: "anthropic",
    judge: false,
    writeBaseline: false,
    check: false,
  };
  let repetitionsGiven = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a}: missing value`);
      return v;
    };
    switch (a) {
      case "readme":
        args.command = "readme";
        break;
      case "--mode": {
        const m = next();
        if (m !== "fake" && m !== "live")
          throw new Error(`--mode: expected fake | live, got "${m}"`);
        args.mode = m;
        break;
      }
      case "--case":
        args.caseId = next();
        break;
      case "--verbose":
        args.verbose = true;
        break;
      case "--repetitions":
        args.repetitions = Number(next());
        repetitionsGiven = true;
        if (!Number.isInteger(args.repetitions) || args.repetitions < 1)
          throw new Error("--repetitions: expected an integer >= 1");
        break;
      case "--cap-usd":
        args.capUsd = Number(next());
        if (!Number.isFinite(args.capUsd) || args.capUsd <= 0)
          throw new Error("--cap-usd: expected a positive number");
        break;
      case "--model":
        args.model = next();
        break;
      case "--judge":
        args.judge = true;
        break;
      case "--provider": {
        const p = next();
        if (p !== "anthropic" && p !== "openai-compatible") {
          throw new Error(`--provider: expected anthropic | openai-compatible, got "${p}"`);
        }
        args.provider = p;
        break;
      }
      case "--write-baseline":
        args.writeBaseline = true;
        break;
      case "--check":
        args.check = true;
        break;
      default:
        throw new Error(`unknown argument "${a}"`);
    }
  }
  if (args.mode === "live" && !repetitionsGiven) {
    args.repetitions =
      Number.isInteger(envReps) && envReps >= 1 ? envReps : DEFAULT_LIVE_REPETITIONS;
  }
  if (args.mode === "fake" && repetitionsGiven && args.repetitions !== 1) {
    throw new Error(
      "--repetitions applies to live mode only (the deterministic mode is exactly repeatable)",
    );
  }
  if (args.writeBaseline && args.caseId) {
    throw new Error("--write-baseline needs the whole golden set (drop --case)");
  }
  if (args.writeBaseline && args.mode !== "live") {
    throw new Error("--write-baseline applies to live mode only");
  }
  return args;
}

export interface Io {
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  error: (line: string) => void;
}

export function currentCommit(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GITHUB_SHA) return env.GITHUB_SHA.slice(0, 7);
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

export interface SuiteOptions {
  pool: ReturnType<typeof makePool>;
  mode: Mode;
  repetitions: number;
  llmFor: (c: EvalCase, ctx: CaseContext) => LLMPort;
  costOf?: (ex: Execution) => number | null;
  onExecution?: (scored: ScoredExecution) => void;
  /** Return true to stop before the next execution (spend cap). */
  shouldStop?: (scored: ScoredExecution[]) => boolean;
  /** Test seam: replaces runCase (no database). */
  run?: (c: EvalCase, opts: RunCaseOptions) => Promise<Execution>;
}

/** No credential → the live run is skipped explicitly (FR-404: never a silent pass). */
export function liveSkipReason(
  env: NodeJS.ProcessEnv,
  provider: Provider = "anthropic",
): string | null {
  if (provider === "openai-compatible") {
    let cfg: ReturnType<typeof fallbackConfig> = null;
    try {
      cfg = fallbackConfig(env);
    } catch {
      cfg = null;
    }
    return cfg
      ? null
      : "FALLBACK_LLM_BASE_URL / FALLBACK_LLM_API_KEY / FALLBACK_LLM_MODEL are not all set — live evaluation of the secondary provider skipped (this is not a pass)";
  }
  return env.ANTHROPIC_API_KEY
    ? null
    : "ANTHROPIC_API_KEY is not set — live evaluation skipped (this is not a pass)";
}

/**
 * FR-411: accumulate the estimated spend and stop as soon as the cap is exceeded. The check is
 * reactive — a run can overshoot the cap by at most one execution (≈ US$ 0.03) or one judge call.
 */
export function capGuard(capUsd: number, cost: (ex: Execution) => number | null) {
  let spent = 0;
  return {
    costOf(ex: Execution): number | null {
      const c = cost(ex);
      if (c !== null) spent += c;
      return c;
    },
    shouldStop(): boolean {
      return spent > capUsd;
    },
    /** Spend outside the per-execution accounting (e.g. the judge). */
    add(usd: number): void {
      spent += usd;
    },
    spentUsd(): number {
      return spent;
    },
  };
}

/** Sums the judge's token usage so its cost shows in the run's estimated spend. */
class MeasuringJudge implements LLMPort {
  usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  constructor(private readonly inner: LLMPort) {}
  async turn(input: Parameters<LLMPort["turn"]>[0]): ReturnType<LLMPort["turn"]> {
    const res = await this.inner.turn(input);
    if (res.usage) {
      this.usage = {
        inputTokens: this.usage.inputTokens + res.usage.inputTokens,
        outputTokens: this.usage.outputTokens + res.usage.outputTokens,
        cacheReadTokens: this.usage.cacheReadTokens + res.usage.cacheReadTokens,
        cacheWriteTokens: this.usage.cacheWriteTokens + res.usage.cacheWriteTokens,
      };
    }
    return res;
  }
}

/** `readme [--check]`: regenerate the README block from the latest LIVE report, or verify it. */
export function readmeCommand(
  args: Args,
  io: Io,
  paths = { readme: README_PATH, report: LATEST_LIVE_REPORT },
): number {
  const report = readLatestLiveReport(paths.report);
  const block = renderBlock(report);
  const readme = readFileSync(paths.readme, "utf8");
  if (args.check) {
    const res = checkBlock(readme, block);
    if (res.ok) {
      io.log(
        `README block is up to date (${report ? `live report ${report.date.slice(0, 10)}` : "no live report yet"})`,
      );
      return 0;
    }
    io.error(`README check failed: ${res.reason}`);
    return 1;
  }
  const next = applyBlock(readme, block);
  if (next === readme) {
    io.log("README block already up to date");
    return 0;
  }
  writeFileSync(paths.readme, next);
  io.log(
    `README block regenerated from ${report ? `live report ${report.date.slice(0, 10)}` : "no live report (placeholder)"}`,
  );
  return 0;
}

export function exitCodeFor(outcome: {
  failed: number;
  stopped: boolean;
  regression: boolean;
}): number {
  return outcome.failed === 0 && !outcome.stopped && !outcome.regression ? 0 : 1;
}

export function readBaseline(path = BASELINE_PATH): Baseline | null {
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as Baseline;
  if (!raw.metrics?.taskSuccess?.byCategory || typeof raw.promptVersion !== "string") {
    throw new Error(
      `${path}: not a baseline (expected { model, promptVersion, date, commit, metrics })`,
    );
  }
  return raw;
}

/** Run every case sequentially (research R3), `repetitions` times each, and score it. */
export async function runSuite(
  cases: EvalCase[],
  opts: SuiteOptions,
): Promise<{ scored: ScoredExecution[]; stopped: boolean }> {
  const scored: ScoredExecution[] = [];
  for (const c of cases) {
    for (let rep = 1; rep <= opts.repetitions; rep++) {
      const run = opts.run ?? runCase;
      const execution = await run(c, {
        pool: opts.pool,
        mode: opts.mode,
        rep,
        llm: (ctx) => opts.llmFor(c, ctx),
      });
      const expectation = opts.mode === "live" && c.liveExpect ? c.liveExpect : c.expect;
      const assertions: Assertion[] = score(execution.observations, expectation);
      const pass = execution.errors.length === 0 && assertions.every((a) => a.pass);
      const s: ScoredExecution = {
        execution,
        assertions,
        pass,
        costUsd: opts.costOf?.(execution) ?? null,
      };
      scored.push(s);
      opts.onExecution?.(s);
      // Checked AFTER accounting for this execution (including the last one): a run that ends
      // over the cap is partial even when nothing was left to run (FR-411).
      if (opts.shouldStop?.(scored)) return { scored, stopped: true };
    }
  }
  return { scored, stopped: false };
}

/**
 * Judge every execution's transcript under the same spend cap: the judge's own cost is added
 * after each call and judging stops (remaining transcripts `skipped`) once the cap is exceeded.
 */
export async function judgeExecutions(
  scored: ScoredExecution[],
  opts: {
    llm: LLMPort;
    rubric: ReturnType<typeof loadRubric>;
    /** USD for the judge usage accumulated so far (null = unknown model). */
    costOfUsage: (usage: MeasuringJudge["usage"]) => number | null;
    guard: ReturnType<typeof capGuard>;
  },
): Promise<{ results: Map<string, JudgeResult>; stopped: boolean }> {
  const results = new Map<string, JudgeResult>();
  const judge = new MeasuringJudge(opts.llm);
  let accounted = 0;
  let stopped = false;
  for (const s of scored) {
    const key = `${s.execution.caseId}#${s.execution.rep}`;
    if (stopped) {
      results.set(key, { status: "skipped", rubricVersion: opts.rubric.version });
      continue;
    }
    results.set(key, await judgeTranscript(judge, opts.rubric, s.execution.transcript));
    const total = opts.costOfUsage(judge.usage);
    if (total !== null) {
      opts.guard.add(total - accounted);
      accounted = total;
    }
    if (opts.guard.shouldStop()) stopped = true;
  }
  return { results, stopped };
}

export function buildReport(input: {
  mode: Mode;
  model: string | null;
  provider: string | null;
  promptVersion: string;
  commit: string;
  date: string;
  durationMs: number;
  repetitions: number;
  capUsd: number | null;
  partial?: boolean;
  spentUsd?: number | null;
  judge: RunReport["judge"];
  /** Judge verdicts keyed by `${caseId}#${rep}` (only when the judge ran). */
  judgeResults?: Map<string, JudgeResult>;
  cases: EvalCase[];
  scored: ScoredExecution[];
  metrics: Metrics;
  baseline: RunReport["baseline"];
}): RunReport {
  const byCase = new Map<string, ScoredExecution[]>();
  for (const s of input.scored) {
    const list = byCase.get(s.execution.caseId) ?? [];
    list.push(s);
    byCase.set(s.execution.caseId, list);
  }
  const cases: CaseReport[] = input.cases
    .filter((c) => byCase.has(c.id))
    .map((c) => ({
      id: c.id,
      category: c.category,
      title: c.title,
      ...(c.limitation !== undefined ? { limitation: c.limitation } : {}),
      executions: (byCase.get(c.id) ?? []).map((s) => ({
        rep: s.execution.rep,
        pass: s.pass,
        failedAssertions: s.assertions.filter((a) => !a.pass).map((a) => a.name),
        assertions: s.assertions,
        errors: s.execution.errors,
        latencyMs: { total: s.execution.latency.totalMs, perTurn: s.execution.latency.perTurnMs },
        llmCalls: s.execution.llm.calls,
        usage: s.execution.llm.usage,
        costUsd: s.costUsd,
        toolCalls: s.execution.observations.toolCalls.map((t) => `${t.name}${t.ok ? "" : "!"}`),
        ...(input.judgeResults?.has(`${s.execution.caseId}#${s.execution.rep}`)
          ? { judge: input.judgeResults.get(`${s.execution.caseId}#${s.execution.rep}`) }
          : {}),
      })),
    }));
  const passed = input.scored.filter((s) => s.pass).length;
  const errors = input.scored.reduce((n, s) => n + s.execution.errors.length, 0);
  return {
    schemaVersion: 1,
    mode: input.mode,
    model: input.model,
    provider: input.provider,
    promptVersion: input.promptVersion,
    commit: input.commit,
    date: input.date,
    durationMs: input.durationMs,
    repetitions: input.repetitions,
    capUsd: input.capUsd,
    partial: input.partial ?? false,
    spentUsd: input.spentUsd ?? null,
    judge: input.judge,
    honesty: HONESTY_LINE,
    summary: {
      cases: cases.length,
      executions: input.scored.length,
      passed,
      failed: input.scored.length - passed,
      errors,
    },
    metrics: input.metrics,
    baseline: input.baseline,
    cases,
  };
}

function formatRow(s: ScoredExecution, verbose: boolean): string {
  const ex = s.execution;
  const mark = s.pass ? "✓" : "✗";
  const failed = s.assertions.filter((a) => !a.pass);
  const head = `${mark} ${ex.caseId}${ex.rep > 1 || s.execution.mode === "live" ? ` #${ex.rep}` : ""} (${ex.category}) ${Math.round(ex.latency.totalMs)} ms · ${ex.llm.calls} call(s)`;
  const lines = [head];
  for (const e of ex.errors) lines.push(`    error [${e.kind}]: ${e.message}`);
  for (const a of verbose ? s.assertions : failed)
    lines.push(`    ${a.pass ? "ok " : "FAIL"} ${a.name}: ${a.detail}`);
  if (verbose)
    lines.push(
      `    tools: ${ex.observations.toolCalls.map((t) => `${t.name}${t.ok ? "" : "!"}`).join(" → ") || "(none)"}`,
    );
  return lines.join("\n");
}

async function runCommand(args: Args, io: Io): Promise<number> {
  const { PROMPT_VERSION } = await import("../src/agent/system-prompt");
  if (args.mode === "live") return liveCommand(args, io, PROMPT_VERSION);
  assertDisposableDatabase(io.env.DATABASE_URL, io.env, "EVALS_ALLOW_TRUNCATE", "the eval harness");
  const all = loadCases(CASES_DIR);
  const cases = args.caseId ? all.filter((c) => c.id === args.caseId) : all;
  if (cases.length === 0) {
    io.error(`no case matches "${args.caseId}"`);
    return 2;
  }
  const pool = makePool();
  const startedAt = new Date();
  const t0 = performance.now();
  try {
    await migrate(pool);
    io.log(`evals · mode=${args.mode} · ${cases.length} case(s) · prompt ${PROMPT_VERSION}`);
    const { scored } = await runSuite(cases, {
      pool,
      mode: "fake",
      repetitions: 1,
      llmFor: (c, ctx) => compileScript(c, ctx),
      onExecution: (s) => io.log(formatRow(s, args.verbose)),
    });
    const metrics = computeMetrics(scored, cases);
    const report = buildReport({
      mode: "fake",
      model: null,
      provider: null,
      promptVersion: PROMPT_VERSION,
      commit: currentCommit(io.env),
      date: startedAt.toISOString(),
      durationMs: Math.round(performance.now() - t0),
      repetitions: 1,
      capUsd: null,
      judge: { enabled: false },
      cases,
      scored,
      metrics,
      baseline: null,
    });
    mkdirSync(FAKE_REPORTS_DIR, { recursive: true });
    const paths = writeReports(FAKE_REPORTS_DIR, report);
    const { summary } = report;
    io.log("");
    io.log(
      `${summary.passed}/${summary.executions} executions passed · ${summary.errors} error(s) · ${(report.durationMs / 1000).toFixed(1)} s`,
    );
    io.log(
      `task success ${fmtPct(metrics.taskSuccess.overall)} · injection resistance ${fmtPct(metrics.injectionResistance)} · triage recall ${fmtPct(metrics.escalation.triage.recall)} · agent recall ${fmtPct(metrics.escalation.agent.recall)}`,
    );
    io.log(`report: ${paths.json} · ${paths.markdown}`);
    return summary.failed === 0 ? 0 : 1;
  } finally {
    await pool.end();
  }
}

const fmtPct = (v: number | null): string => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);

async function liveCommand(args: Args, io: Io, promptVersion: string): Promise<number> {
  const skip = liveSkipReason(io.env, args.provider);
  if (skip) {
    io.log(`evals · live mode skipped: ${skip}`);
    return 0;
  }
  assertDisposableDatabase(io.env.DATABASE_URL, io.env, "EVALS_ALLOW_TRUNCATE", "the eval harness");
  const pricing = loadPricing();
  const fb = args.provider === "openai-compatible" ? fallbackConfig(io.env) : null;
  const model = args.model ?? (fb ? fb.model : io.env.ANTHROPIC_MODEL || DEFAULT_MODEL);
  try {
    // An unpriced model would make the spend cap inert (005 FR-512).
    assertPriced(pricing, [model]);
  } catch (e) {
    io.error(`evals: ${(e as Error).message}`);
    return 2;
  }
  const llm = fb
    ? new OpenAICompatibleLLM({ ...fb, model })
    : new AnthropicLLM({ apiKey: io.env.ANTHROPIC_API_KEY, model });
  let judgeModel: string | null = null;
  let rubric: ReturnType<typeof loadRubric> | null = null;
  if (args.judge) {
    try {
      judgeModel = judgeModelFor(model, io.env.EVALS_JUDGE_MODEL || undefined);
      rubric = loadRubric();
    } catch (e) {
      io.error(`evals: ${(e as Error).message}`);
      return 2;
    }
  }
  const all = loadCases(CASES_DIR);
  const cases = args.caseId ? all.filter((c) => c.id === args.caseId) : all;
  if (cases.length === 0) {
    io.error(`no case matches "${args.caseId}"`);
    return 2;
  }
  const guard = capGuard(args.capUsd, (ex) => costUsd(pricing, model, ex.llm.usage, io.error));
  const pool = makePool();
  const startedAt = new Date();
  const t0 = performance.now();
  try {
    await migrate(pool);
    io.log(
      `evals · mode=live · model=${model} (${args.provider}) · ${cases.length} case(s) × ${args.repetitions} · cap US$ ${args.capUsd.toFixed(2)} · prompt ${promptVersion} · pricing as of ${pricing.asOf}`,
    );
    const { scored, stopped } = await runSuite(cases, {
      pool,
      mode: "live",
      repetitions: args.repetitions,
      llmFor: () => llm,
      costOf: guard.costOf,
      shouldStop: guard.shouldStop,
      // The owner's credit is small: every live execution shows what it cost (005 R11).
      onExecution: (s) =>
        io.log(
          `${formatRow(s, args.verbose)}\n    est. US$ ${(s.costUsd ?? 0).toFixed(4)} · cache read ${s.execution.llm.usage.cacheReadTokens} tok · running total US$ ${guard.spentUsd().toFixed(4)}`,
        ),
    });
    const metrics = computeMetrics(scored, cases, { table: pricing, model });
    const baseline = readBaseline();
    const comparison = baseline
      ? compareWithBaseline(metrics, baseline, 5, { model, promptVersion })
      : null;
    const commit = currentCommit(io.env);
    // Judge (off by default): a separate model scores tone/clarity of the agent replies under
    // the SAME spend cap (its cost never enters the agent's cost metrics). Not run at all when
    // the agent suite already stopped at the cap.
    let judgeResults = new Map<string, JudgeResult>();
    let judgeStopped = false;
    if (judgeModel && rubric) {
      if (stopped) {
        io.log("judge · skipped: the spend cap was reached during the agent run");
      } else {
        io.log(`judge · model=${judgeModel} · rubric ${rubric.version}`);
        const judged = await judgeExecutions(scored, {
          llm: new AnthropicLLM({ apiKey: io.env.ANTHROPIC_API_KEY, model: judgeModel }),
          rubric,
          costOfUsage: (usage) => costUsd(pricing, judgeModel, usage, io.error),
          guard,
        });
        judgeResults = judged.results;
        judgeStopped = judged.stopped;
        if (judgeStopped) io.log("judge · PARTIAL: the spend cap was reached while judging");
      }
    }
    const partial = stopped || judgeStopped;
    const report = buildReport({
      mode: "live",
      model,
      provider: args.provider,
      promptVersion,
      commit,
      date: startedAt.toISOString(),
      durationMs: Math.round(performance.now() - t0),
      repetitions: args.repetitions,
      capUsd: args.capUsd,
      partial,
      spentUsd: metrics.cost.totalUsd === null ? null : guard.spentUsd(),
      judge:
        judgeModel && rubric
          ? { enabled: true, model: judgeModel, rubricVersion: rubric.version }
          : { enabled: false },
      judgeResults,
      cases,
      scored,
      metrics,
      baseline: comparison,
    });
    const paths = writeReports(REPORTS_DIR, report);
    if (args.writeBaseline) {
      if (partial) {
        io.error("refusing to write a baseline from a partial run");
      } else {
        const b: Baseline = { model, promptVersion, date: report.date, commit, metrics };
        writeFileSync(BASELINE_PATH, `${JSON.stringify(b, null, 2)}\n`);
        io.log(`baseline written: ${BASELINE_PATH} (commit it through a reviewed PR)`);
      }
    }
    const { summary } = report;
    io.log("");
    if (partial) {
      io.log(
        `PARTIAL: spend cap US$ ${args.capUsd.toFixed(2)} exceeded after ${summary.executions} execution(s) (estimate US$ ${guard.spentUsd().toFixed(4)})`,
      );
    }
    io.log(
      `${summary.passed}/${summary.executions} executions passed · ${summary.errors} error(s) · ${(report.durationMs / 1000).toFixed(1)} s · est. US$ ${guard.spentUsd().toFixed(4)}`,
    );
    io.log(
      `task success ${fmtPct(metrics.taskSuccess.overall)} · injection resistance ${fmtPct(metrics.injectionResistance)} · triage recall ${fmtPct(metrics.escalation.triage.recall)} · agent recall ${fmtPct(metrics.escalation.agent.recall)}`,
    );
    if (!baseline) {
      io.log(
        "warning: no evals/baseline.json — nothing to compare against; use --write-baseline on a reviewed run",
      );
    } else if (comparison && !comparison.pass) {
      for (const r of comparison.regressions)
        io.log(`REGRESSION ${r.metric}: ${fmtPct(r.baseline)} → ${fmtPct(r.current)}`);
    } else {
      io.log(
        `no regression vs baseline ${baseline.date} (${baseline.model ?? "—"}, ${baseline.promptVersion})`,
      );
    }
    if (comparison && (!comparison.sameModel || !comparison.samePromptVersion)) {
      io.log(
        `note: baseline model/prompt differ from this run (${baseline?.model ?? "—"} / ${baseline?.promptVersion} vs ${model} / ${promptVersion})`,
      );
    }
    io.log(`report: ${paths.json} · ${paths.markdown}`);
    return exitCodeFor({
      failed: summary.failed,
      stopped: partial,
      regression: comparison ? !comparison.pass : false,
    });
  } finally {
    await pool.end();
  }
}

export async function main(
  argv: string[],
  io: Io = { env: process.env, log: console.log, error: console.error },
): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv, io.env);
  } catch (e) {
    io.error(`evals: ${(e as Error).message}`);
    return 2;
  }
  if (args.command === "readme") {
    try {
      return readmeCommand(args, io);
    } catch (e) {
      io.error(`evals readme: ${(e as Error).message}`);
      return 2;
    }
  }
  return runCommand(args, io);
}

const isEntrypoint =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) {
  loadEnv();
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}

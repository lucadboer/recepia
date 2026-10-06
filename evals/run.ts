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
import { assertDisposableDatabase } from "../src/db/disposable";
import { loadEnv } from "../src/db/env";
import { migrate } from "../src/db/migrate";
import { makePool } from "../src/db/pool";
import type { LLMPort } from "../src/ports/llm-port";
import { type Assertion, score } from "./lib/assertions";
import { type EvalCase, loadCases } from "./lib/case-schema";
import {
  type Baseline,
  compareWithBaseline,
  computeMetrics,
  type Metrics,
  type ScoredExecution,
} from "./lib/metrics";
import { costUsd, loadPricing } from "./lib/pricing";
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
  judge: boolean;
  writeBaseline: boolean;
  check: boolean;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = {}): Args {
  const envCap = Number(env.EVALS_CAP_USD);
  const envReps = Number(env.EVALS_REPETITIONS);
  const args: Args = {
    command: "run",
    mode: "fake",
    verbose: false,
    repetitions: 1,
    capUsd: Number.isFinite(envCap) && envCap > 0 ? envCap : DEFAULT_CAP_USD,
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
export function liveSkipReason(env: NodeJS.ProcessEnv): string | null {
  return env.ANTHROPIC_API_KEY
    ? null
    : "ANTHROPIC_API_KEY is not set — live evaluation skipped (this is not a pass)";
}

/** FR-411: accumulate the estimated spend and stop before the next execution once the cap is exceeded. */
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
    spentUsd(): number {
      return spent;
    },
  };
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
      if (opts.shouldStop?.(scored)) return { scored, stopped: true };
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
    }
  }
  return { scored, stopped: false };
}

export function buildReport(input: {
  mode: Mode;
  model: string | null;
  promptVersion: string;
  commit: string;
  date: string;
  durationMs: number;
  repetitions: number;
  capUsd: number | null;
  partial?: boolean;
  spentUsd?: number | null;
  judge: RunReport["judge"];
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
      })),
    }));
  const passed = input.scored.filter((s) => s.pass).length;
  const errors = input.scored.reduce((n, s) => n + s.execution.errors.length, 0);
  return {
    schemaVersion: 1,
    mode: input.mode,
    model: input.model,
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
  const skip = liveSkipReason(io.env);
  if (skip) {
    io.log(`evals · live mode skipped: ${skip}`);
    return 0;
  }
  if (args.judge) {
    io.error("--judge arrives with feature 004 US5 (T449)");
    return 2;
  }
  assertDisposableDatabase(io.env.DATABASE_URL, io.env, "EVALS_ALLOW_TRUNCATE", "the eval harness");
  const pricing = loadPricing();
  const model = args.model ?? (io.env.ANTHROPIC_MODEL || DEFAULT_MODEL);
  const llm = new AnthropicLLM({ apiKey: io.env.ANTHROPIC_API_KEY, model });
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
      `evals · mode=live · model=${model} · ${cases.length} case(s) × ${args.repetitions} · cap US$ ${args.capUsd.toFixed(2)} · prompt ${promptVersion} · pricing as of ${pricing.asOf}`,
    );
    const { scored, stopped } = await runSuite(cases, {
      pool,
      mode: "live",
      repetitions: args.repetitions,
      llmFor: () => llm,
      costOf: guard.costOf,
      shouldStop: guard.shouldStop,
      onExecution: (s) => io.log(formatRow(s, args.verbose)),
    });
    const metrics = computeMetrics(scored, cases);
    const baseline = readBaseline();
    const comparison = baseline ? compareWithBaseline(metrics, baseline) : null;
    const commit = currentCommit(io.env);
    const report = buildReport({
      mode: "live",
      model,
      promptVersion,
      commit,
      date: startedAt.toISOString(),
      durationMs: Math.round(performance.now() - t0),
      repetitions: args.repetitions,
      capUsd: args.capUsd,
      partial: stopped,
      spentUsd: metrics.cost.totalUsd === null ? null : guard.spentUsd(),
      judge: { enabled: false },
      cases,
      scored,
      metrics,
      baseline: comparison,
    });
    const paths = writeReports(REPORTS_DIR, report);
    if (args.writeBaseline) {
      if (stopped) {
        io.error("refusing to write a baseline from a partial run");
      } else {
        const b: Baseline = { model, promptVersion, date: report.date, commit, metrics };
        writeFileSync(BASELINE_PATH, `${JSON.stringify(b, null, 2)}\n`);
        io.log(`baseline written: ${BASELINE_PATH} (commit it through a reviewed PR)`);
      }
    }
    const { summary } = report;
    io.log("");
    if (stopped) {
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
    io.log(`report: ${paths.json} · ${paths.markdown}`);
    return exitCodeFor({
      failed: summary.failed,
      stopped,
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
    io.error("readme subcommand arrives with feature 004 US4 (T445)");
    return 2;
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

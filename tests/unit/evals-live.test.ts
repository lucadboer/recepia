import { describe, expect, it } from "vitest";
import { type EvalCase, validateCase } from "../../evals/lib/case-schema";
import type { Execution } from "../../evals/lib/runner";
import { capGuard, exitCodeFor, liveSkipReason, main, runSuite } from "../../evals/run";

// T434 — live-mode behaviour that must hold without a key, a database or a network:
// explicit skip, spend cap → partial + non-zero exit, repetitions, errors never scored as success.

function makeCase(id: string): EvalCase {
  return validateCase({
    id,
    category: "happy_path",
    title: id,
    seed: { now: "2026-06-15T12:00:00Z", capacity: [], consent: "opted_in" },
    patient: { phone: "+5531900000101" },
    turns: [{ text: "oi" }],
    llmScript: [[{ text: "x" }]],
    labels: { shouldEscalate: false },
    expect: { status: "active" },
    liveExpect: { status: "active", patientMessages: 0 },
  });
}

function fakeExecution(caseId: string, rep: number, over: Partial<Execution> = {}): Execution {
  return {
    caseId,
    category: "happy_path",
    rep,
    mode: "live",
    promptVersion: "v001+0000000",
    observations: {
      toolCalls: [],
      writes: { holds: 0, bookings: 0, calendarEvents: 0, escalations: 0 },
      escalations: [],
      offeredSlots: [],
      heldStarts: [],
      ownHoldIds: [],
      writesWithoutConsent: 0,
      status: "active",
      messages: [],
      patientPhone: "+5531900000101",
      llmCalls: 1,
      foreignWrites: 0,
    },
    latency: { perTurnMs: [1], totalMs: 1 },
    llm: {
      calls: 1,
      perCallMs: [1],
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    errors: [],
    transcript: [],
    ...over,
  };
}

const noPool = {} as never;

describe("live mode without a credential", () => {
  it("prints an explicit skipped notice, exits 0 and writes nothing", async () => {
    const log: string[] = [];
    const code = await main(["--mode", "live"], {
      env: { DATABASE_URL: "postgres://x" },
      log: (l) => log.push(l),
      error: (l) => log.push(l),
    });
    expect(code).toBe(0);
    expect(log.join("\n")).toMatch(/skipped.*ANTHROPIC_API_KEY/i);
    expect(liveSkipReason({})).toMatch(/ANTHROPIC_API_KEY/);
    expect(liveSkipReason({ ANTHROPIC_API_KEY: "sk-ant-x" })).toBeNull();
  });
});

describe("live mode argument validation (no database reached)", () => {
  it("refuses a judge model equal to the model under test before touching the database", async () => {
    const log: string[] = [];
    const code = await main(["--mode", "live", "--judge"], {
      env: {
        ANTHROPIC_API_KEY: "sk-ant-test",
        DATABASE_URL: "postgres://u:p@localhost:5434/db",
        EVALS_JUDGE_MODEL: "claude-sonnet-5-5",
      },
      log: (l) => log.push(l),
      error: (l) => log.push(l),
    });
    expect(code).toBe(2);
    expect(log.join("\n")).toMatch(/different from the model under test/);
  });
});

describe("runSuite in live mode (execution injected, no database)", () => {
  it("honours repetitions and uses liveExpect instead of expect", async () => {
    const cases = [makeCase("a"), makeCase("b")];
    const seen: string[] = [];
    const { scored, stopped } = await runSuite(cases, {
      pool: noPool,
      mode: "live",
      repetitions: 3,
      llmFor: () => ({ turn: async () => ({ stopReason: "end_turn", content: [] }) }),
      run: async (c, o) => {
        seen.push(`${c.id}#${o.rep}`);
        return fakeExecution(c.id, o.rep ?? 1);
      },
    });
    expect(stopped).toBe(false);
    expect(seen).toEqual(["a#1", "a#2", "a#3", "b#1", "b#2", "b#3"]);
    expect(scored).toHaveLength(6);
    expect(scored.every((s) => s.pass)).toBe(true);
    expect(scored[0].assertions.map((a) => a.name)).toContain("patientMessages"); // from liveExpect
  });

  it("stops when the spend cap would be exceeded and reports the partial run", async () => {
    const cases = [makeCase("a"), makeCase("b"), makeCase("c")];
    const guard = capGuard(
      0.005,
      (ex) => ex.llm.usage.inputTokens * 0.000002 + ex.llm.usage.outputTokens * 0.00001,
    ); // 0.003 per execution
    const { scored, stopped } = await runSuite(cases, {
      pool: noPool,
      mode: "live",
      repetitions: 1,
      llmFor: () => ({ turn: async () => ({ stopReason: "end_turn", content: [] }) }),
      run: async (c, o) => fakeExecution(c.id, o.rep ?? 1),
      costOf: guard.costOf,
      shouldStop: guard.shouldStop,
    });
    expect(stopped).toBe(true);
    expect(scored).toHaveLength(2); // the third would push the total over the cap
    expect(guard.spentUsd()).toBeCloseTo(0.006);
    expect(exitCodeFor({ failed: 0, stopped: true, regression: false })).toBe(1);
  });

  it("an execution with a model/transient error is counted and never scored as success", async () => {
    const cases = [makeCase("a")];
    const { scored } = await runSuite(cases, {
      pool: noPool,
      mode: "live",
      repetitions: 2,
      llmFor: () => ({ turn: async () => ({ stopReason: "end_turn", content: [] }) }),
      run: async (c, o) =>
        fakeExecution(
          c.id,
          o.rep ?? 1,
          o.rep === 2 ? { errors: [{ kind: "rate_limit", message: "429 too many requests" }] } : {},
        ),
    });
    expect(scored.map((s) => s.pass)).toEqual([true, false]);
    expect(scored[1].execution.errors[0].kind).toBe("rate_limit");
  });

  it("exit code: 0 only when nothing failed, nothing was cut short and no regression was found", () => {
    expect(exitCodeFor({ failed: 0, stopped: false, regression: false })).toBe(0);
    expect(exitCodeFor({ failed: 1, stopped: false, regression: false })).toBe(1);
    expect(exitCodeFor({ failed: 0, stopped: false, regression: true })).toBe(1);
  });
});

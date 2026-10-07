import { describe, expect, it } from "vitest";
import type { Assertion } from "../../evals/lib/assertions";
import { type EvalCase, validateCase } from "../../evals/lib/case-schema";
import {
  type Baseline,
  compareWithBaseline,
  computeMetrics,
  percentile,
  resisted,
  type ScoredExecution,
} from "../../evals/lib/metrics";
import type { Execution } from "../../evals/lib/runner";

// T432 — every metric on hand-computed fixtures; zero denominators → null; baseline comparison.

function makeCase(
  id: string,
  category: string,
  shouldEscalate: boolean,
  text = "quero marcar uma limpeza",
): EvalCase {
  return validateCase({
    id,
    category,
    title: id,
    seed: { now: "2026-06-15T12:00:00Z", capacity: [], consent: "opted_in" },
    patient: { phone: "+5531900000101" },
    turns: [{ text }],
    llmScript: [[{ text: "x" }]],
    labels: { shouldEscalate },
    expect: shouldEscalate
      ? { escalation: { expected: true } }
      : category === "injection"
        ? { writes: { bookings: 0, calendarEvents: 0 } }
        : {},
  });
}

const ok = (name: string): Assertion => ({ name, pass: true, detail: "" });
const ko = (name: string): Assertion => ({ name, pass: false, detail: "" });

function exec(
  caseId: string,
  over: Partial<{
    escalations: number;
    perTurnMs: number[];
    totalMs: number;
    usage: Execution["llm"]["usage"];
    errors: Execution["errors"];
  }> = {},
): Execution {
  return {
    caseId,
    category: "happy_path",
    rep: 1,
    mode: "fake",
    promptVersion: "v001+0000000",
    observations: {
      toolCalls: [],
      writes: { holds: 0, bookings: 0, calendarEvents: 0, escalations: over.escalations ?? 0 },
      escalations: Array.from({ length: over.escalations ?? 0 }, () => ({ reason: "x" })),
      offeredSlots: [],
      heldStarts: [],
      ownHoldIds: [],
      writesWithoutConsent: 0,
      status: "active",
      messages: [],
      patientPhone: "+5531900000101",
      llmCalls: 0,
      foreignWrites: 0,
    },
    latency: { perTurnMs: over.perTurnMs ?? [10], totalMs: over.totalMs ?? 10 },
    llm: {
      calls: 1,
      perCallMs: [5],
      usage: over.usage ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
    errors: over.errors ?? [],
    transcript: [],
  };
}

function scored(
  execution: Execution,
  assertions: Assertion[],
  costUsd: number | null = null,
): ScoredExecution {
  return {
    execution,
    assertions,
    pass: execution.errors.length === 0 && assertions.every((a) => a.pass),
    costUsd,
  };
}

describe("percentile (nearest rank)", () => {
  it("matches hand-computed values and returns null for an empty sample", () => {
    expect(percentile([40, 10, 30, 20], 50)).toBe(20);
    expect(percentile([40, 10, 30, 20], 95)).toBe(40);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });
});

describe("computeMetrics", () => {
  const cases = [
    makeCase("h1", "happy_path", false),
    makeCase("h2", "happy_path", false),
    makeCase("o1", "out_of_scope", true, "estou com dor"),
    makeCase("r1", "reschedule_cancel", true, "quero remarcar"),
    makeCase("i1", "injection", false),
  ];

  it("task success overall and by category; tool-call accuracy only over executions with tool expectations", () => {
    const s = [
      scored(exec("h1"), [ok("toolCalls.mustInclude"), ok("status")]),
      scored(exec("h2"), [ko("toolCalls.mustInclude")]),
      scored(exec("o1", { escalations: 1 }), [ok("escalation")]),
      scored(exec("r1", { escalations: 1 }), [ok("escalation")]),
      scored(exec("i1"), [ok("noWriteWithoutConsent"), ok("writes.bookings")]),
    ];
    const m = computeMetrics(s, cases);
    expect(m.taskSuccess.overall).toBe(0.8);
    expect(m.taskSuccess.byCategory).toEqual({
      happy_path: 0.5,
      out_of_scope: 1,
      reschedule_cancel: 1,
      injection: 1,
    });
    expect(m.toolCallAccuracy).toBe(0.5); // h1 ok, h2 failed; the others have no tool expectations
  });

  it("escalation precision/recall for triage alone (regex over the turns) and for the full agent", () => {
    const s = [
      scored(exec("h1"), []),
      scored(exec("h2", { escalations: 1 }), []), // agent escalated a non-escalation case → FP
      scored(exec("o1", { escalations: 1 }), []),
      scored(exec("r1"), []), // agent missed → FN
      scored(exec("i1"), []),
    ];
    const m = computeMetrics(s, cases);
    // triage: predicts o1 (dor) only; labels: o1, r1 → precision 1/1, recall 1/2
    expect(m.escalation.triage).toEqual({ precision: 1, recall: 0.5 });
    // agent: predicted h2, o1; actual o1, r1 → tp 1, fp 1, fn 1
    expect(m.escalation.agent).toEqual({ precision: 0.5, recall: 0.5 });
  });

  it("zero denominators are null, never NaN", () => {
    const only = [makeCase("h1", "happy_path", false)];
    const m = computeMetrics([scored(exec("h1"), [])], only);
    expect(m.escalation.triage).toEqual({ precision: null, recall: null });
    expect(m.escalation.agent).toEqual({ precision: null, recall: null });
    expect(m.injectionResistance).toBeNull();
    expect(m.toolCallAccuracy).toBeNull();
    expect(computeMetrics([], []).taskSuccess.overall).toBeNull();
    expect(computeMetrics([], []).latency.turnP50Ms).toBeNull();
  });

  it("injection resistance counts adversarial executions whose write invariants and write counts held", () => {
    const inj = [
      makeCase("i1", "injection", false),
      makeCase("i2", "injection", false),
      makeCase("i3", "injection", false),
    ];
    const s = [
      scored(exec("i1"), [
        ok("noWriteWithoutConsent"),
        ok("writes.bookings"),
        ko("patientMessages"),
      ]), // resisted, but failed wording-ish count
      scored(exec("i2"), [ko("noHallucinatedSlots")]),
      scored(exec("i3"), [ok("noForeignWrites"), ko("writes.holds")]),
    ];
    expect(resisted(s[0])).toBe(true);
    expect(resisted(s[1])).toBe(false);
    expect(resisted(s[2])).toBe(false);
    expect(computeMetrics(s, inj).injectionResistance).toBeCloseTo(1 / 3);
  });

  it("latency percentiles per turn and per conversation; tokens, cost and error counts", () => {
    const s = [
      scored(
        exec("h1", {
          perTurnMs: [10, 30],
          totalMs: 40,
          usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 1 },
        }),
        [],
        0.01,
      ),
      scored(
        exec("h2", {
          perTurnMs: [20, 40],
          totalMs: 60,
          usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
          errors: [
            { kind: "rate_limit", message: "429" },
            { kind: "timeout", message: "t" },
          ],
        }),
        [],
        0.02,
      ),
    ];
    const m = computeMetrics(s, cases.slice(0, 2));
    expect(m.latency).toEqual({
      turnP50Ms: 20,
      turnP95Ms: 40,
      conversationP50Ms: 40,
      conversationP95Ms: 60,
    });
    expect(m.cost.tokens).toEqual({ input: 300, output: 30, cacheRead: 5, cacheWrite: 1 });
    expect(m.cost.totalUsd).toBeCloseTo(0.03);
    expect(m.cost.perConversationUsd).toBeCloseTo(0.015);
    expect(m.errors).toEqual({ total: 2, byKind: { rate_limit: 1, timeout: 1 } });
    // An execution with an error is never a success, whatever its assertions say.
    expect(s[1].pass).toBe(false);
    // 005 SC-504: cache hit ratio from the same tokens, and what they would cost uncached.
    expect(m.cost.cacheHitRatio).toBeCloseTo(5 / 306, 9);
    expect(m.cost.uncachedPerConversationUsd).toBeNull(); // no pricing given
    const priced = computeMetrics(s, cases.slice(0, 2), {
      table: {
        asOf: "2026-09-25",
        source: "t",
        usdPerMTok: {
          "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
        },
      },
      model: "claude-sonnet-5-5",
    });
    expect(priced.cost.uncachedPerConversationUsd).toBeCloseTo(
      (306 * 2 + 30 * 10) / 1_000_000 / 2,
      12,
    );
    expect(computeMetrics([], []).cost.cacheHitRatio).toBeNull();
    // Unknown pricing anywhere → total cost unknown.
    const unknown = computeMetrics([scored(exec("h1"), [], null), s[0]], cases.slice(0, 2));
    expect(unknown.cost.totalUsd).toBeNull();
    expect(unknown.cost.perConversationUsd).toBeNull();
  });
});

describe("compareWithBaseline", () => {
  const baseline: Baseline = {
    model: "claude-sonnet-5-5",
    promptVersion: "v001+0000000",
    date: "2026-10-01T00:00:00.000Z",
    commit: "abc",
    metrics: {
      taskSuccess: { overall: 0.9, byCategory: { happy_path: 1, injection: 0.9, out_of_scope: 1 } },
      toolCallAccuracy: 0.9,
      escalation: { triage: { precision: 1, recall: 0.6 }, agent: { precision: 1, recall: 1 } },
      injectionResistance: 1,
      latency: { turnP50Ms: 1, turnP95Ms: 2, conversationP50Ms: 3, conversationP95Ms: 4 },
      cost: {
        perConversationUsd: 0.03,
        totalUsd: 1,
        uncachedPerConversationUsd: null,
        cacheHitRatio: null,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      errors: { total: 0, byKind: {} },
    },
  };
  const current = (
    over: Partial<{
      happy: number | null;
      injection: number | null;
      resistance: number | null;
      extra: Record<string, number | null>;
    }> = {},
  ) => ({
    ...baseline.metrics,
    taskSuccess: {
      overall: 0.9,
      byCategory: {
        happy_path: over.happy === undefined ? 1 : over.happy,
        injection: over.injection === undefined ? 0.9 : over.injection,
        out_of_scope: 1,
        ...(over.extra ?? {}),
      },
    },
    injectionResistance: over.resistance === undefined ? 1 : over.resistance,
  });

  it("passes within the tolerance (5 pp) and fails beyond it, naming the metric and the delta", () => {
    expect(compareWithBaseline(current({ happy: 0.96 }), baseline).pass).toBe(true);
    const r = compareWithBaseline(current({ happy: 0.9 }), baseline);
    expect(r.pass).toBe(false);
    expect(r.regressions).toHaveLength(1);
    expect(r.regressions[0]).toMatchObject({
      metric: "taskSuccess.byCategory.happy_path",
      baseline: 1,
      current: 0.9,
    });
    expect(r.regressions[0].delta).toBeCloseTo(-0.1);
    expect(r.baselineDate).toBe(baseline.date);
    expect(r.baselineModel).toBe("claude-sonnet-5-5");
    expect(r.baselinePromptVersion).toBe("v001+0000000");
  });

  it("any adversarial write (injection resistance < 1) is a regression regardless of tolerance", () => {
    const r = compareWithBaseline(current({ resistance: 0.97 }), baseline);
    expect(r.pass).toBe(false);
    expect(r.regressions.map((x) => x.metric)).toContain("injectionResistance");
  });

  it("a category missing from the baseline, or null on either side, is not a regression", () => {
    expect(compareWithBaseline(current({ extra: { ambiguous_date: 0.5 } }), baseline).pass).toBe(
      true,
    );
    expect(compareWithBaseline(current({ happy: null }), baseline).pass).toBe(true);
    const nullBase: Baseline = {
      ...baseline,
      metrics: {
        ...baseline.metrics,
        taskSuccess: { overall: null, byCategory: { happy_path: null } },
      },
    };
    expect(compareWithBaseline(current({ happy: 0.1 }), nullBase).pass).toBe(true);
  });

  it("records whether the run used the baseline's model and prompt (informational, never a failure)", () => {
    const same = compareWithBaseline(current(), baseline, 5, {
      model: "claude-sonnet-5-5",
      promptVersion: "v001+0000000",
    });
    expect(same).toMatchObject({ sameModel: true, samePromptVersion: true, pass: true });
    const other = compareWithBaseline(current(), baseline, 5, {
      model: "claude-haiku-4-5",
      promptVersion: "v002+1111111",
    });
    expect(other).toMatchObject({ sameModel: false, samePromptVersion: false, pass: true });
  });

  it("the tolerance is configurable", () => {
    expect(compareWithBaseline(current({ happy: 0.9 }), baseline, 10).pass).toBe(true);
  });
});

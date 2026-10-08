import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCases } from "../../evals/lib/case-schema";
import { computeMetrics } from "../../evals/lib/metrics";
import { compileScript } from "../../evals/lib/script";
import { CASES_DIR, runSuite } from "../../evals/run";
import type { Pool } from "../../src/db/pool";
import { ensureSchema, testPool } from "../helpers/db";

// T419 (SC-401) — the whole golden set passes on the current code in deterministic mode and
// two consecutive runs produce identical per-case results (pass/fail, assertions, tool calls).

let pool: Pool;
beforeAll(async () => {
  pool = testPool();
  await ensureSchema(pool);
});
afterAll(async () => {
  await pool.end();
});

const fingerprint = (scored: Awaited<ReturnType<typeof runSuite>>["scored"]) =>
  scored.map((s) => ({
    id: s.execution.caseId,
    pass: s.pass,
    assertions: s.assertions.map((a) => `${a.name}=${a.pass}`),
    tools: s.execution.observations.toolCalls.map((t) => `${t.name}:${t.ok}`),
    status: s.execution.observations.status,
    errors: s.execution.errors.map((e) => e.kind),
  }));

describe("golden set — deterministic mode", () => {
  it("has at least 40 cases, at least 8 adversarial, every category present (FR-401)", () => {
    const cases = loadCases(CASES_DIR);
    expect(cases.length).toBeGreaterThanOrEqual(40);
    expect(cases.filter((c) => c.category === "injection").length).toBeGreaterThanOrEqual(8);
    const categories = new Set(cases.map((c) => c.category));
    for (const cat of [
      "happy_path",
      "alternative_slot",
      "reschedule_cancel",
      "ambiguous_date",
      "out_of_scope",
      "opt_out",
      "consent_refusal",
      "injection",
      "reminder",
    ]) {
      expect(categories.has(cat as never)).toBe(true);
    }
    // 006 made cancel/reschedule real and 007 attendance confirmation: no known limitation is left.
    expect(cases.filter((x) => x.limitation).map((x) => x.id)).toEqual([]);
  });

  it("passes every case and is exactly repeatable across two runs (SC-401)", async () => {
    const cases = loadCases(CASES_DIR);
    const run = () =>
      runSuite(cases, {
        pool,
        mode: "fake",
        repetitions: 1,
        llmFor: (c, ctx) => compileScript(c, ctx),
      });
    const first = await run();
    const failures = first.scored
      .filter((s) => !s.pass)
      .map(
        (s) =>
          `${s.execution.caseId}: ${s.assertions
            .filter((a) => !a.pass)
            .map((a) => `${a.name} (${a.detail})`)
            .join(
              "; ",
            )}${s.execution.errors.map((e) => ` error ${e.kind}: ${e.message}`).join("")}`,
      );
    expect(failures).toEqual([]);
    const second = await run();
    expect(fingerprint(second.scored)).toEqual(fingerprint(first.scored));

    const metrics = computeMetrics(first.scored, cases);
    expect(metrics.taskSuccess.overall).toBe(1);
    expect(metrics.injectionResistance).toBe(1); // SC-402
    expect(metrics.escalation.agent.recall).toBe(1);
    expect(metrics.escalation.agent.precision).toBe(1);
    // Triage alone cannot see reschedule/cancel requests: recall < 1 is the honest number.
    expect(metrics.escalation.triage.recall).toBeLessThan(1);
    expect(metrics.escalation.triage.precision).toBe(1);
  }, 180_000);
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type EvalCase, FOREIGN_PHONE, validateCase } from "../../evals/lib/case-schema";
import { type CaseContext, runCase } from "../../evals/lib/runner";
import { FakeLLM, finalTurn, toolUse, toolUseTurn } from "../../src/adapters/fakes/fake-llm";
import { TOOL_NAMES } from "../../src/agent/tool-schemas";
import type { Pool } from "../../src/db/pool";
import type { LLMPort } from "../../src/ports/llm-port";
import { lastHoldId } from "../helpers/agent";
import { ensureSchema, testPool } from "../helpers/db";

// T415 — the single-case runner drives the REAL orchestrator against the real database with
// fake Calendar/WhatsApp and a caller-provided LLM, and turns the outcome into observations.

const NOW = "2026-06-15T12:00:00Z"; // Monday 09:00 local
const PHONE = "+5531900000101";
const RANGE = { from: "2026-06-15T12:00:00Z", to: "2026-06-15T18:00:00Z", type: "cleaning" };
const FIRST_SLOT = "2026-06-15T14:00:00.000Z"; // 11:00 local = now + 2h

let pool: Pool;
beforeAll(async () => {
  pool = testPool();
  await ensureSchema(pool);
});
afterAll(async () => {
  await pool.end();
});

function baseCase(over: Partial<Record<keyof EvalCase, unknown>> = {}): EvalCase {
  return validateCase({
    id: "inline-case",
    category: "happy_path",
    title: "inline",
    seed: {
      now: NOW,
      capacity: [{ weekday: 1, start: "09:00", end: "18:00", capacity: 2 }],
      consent: "opted_in",
    },
    patient: { phone: PHONE },
    turns: [{ text: "quero marcar uma limpeza" }],
    llmScript: [[{ text: "x" }]],
    labels: { shouldEscalate: false },
    expect: {},
    ...over,
  });
}

const bookingScript = (): LLMPort =>
  new FakeLLM([
    toolUseTurn(toolUse(TOOL_NAMES.availability, RANGE)),
    toolUseTurn(toolUse(TOOL_NAMES.hold, { start: FIRST_SLOT, type: "cleaning" })),
    (i) =>
      toolUseTurn(
        toolUse(TOOL_NAMES.confirm, { hold_id: lastHoldId(i.messages), patient_name: "Ana Teste" }),
      ),
    finalTurn("Confirmado!"),
  ]);

describe("runCase — observations over the real orchestrator", () => {
  it("happy path: 1 hold, 1 booking, 1 calendar event, status completed, latency + usage recorded", async () => {
    const ex = await runCase(baseCase(), { pool, llm: bookingScript(), mode: "fake" });

    expect(ex.errors).toEqual([]);
    expect(ex.observations.writes).toEqual({
      holds: 1,
      bookings: 1,
      calendarEvents: 1,
      escalations: 0,
    });
    expect(ex.observations.status).toBe("completed");
    expect(ex.observations.toolCalls.map((c) => [c.name, c.ok])).toEqual([
      [TOOL_NAMES.availability, true],
      [TOOL_NAMES.hold, true],
      [TOOL_NAMES.confirm, true],
    ]);
    expect(ex.observations.offeredSlots).toContain(FIRST_SLOT);
    expect(ex.observations.heldStarts).toEqual([FIRST_SLOT]);
    expect(ex.observations.ownHoldIds).toHaveLength(1);
    expect(ex.observations.writesWithoutConsent).toBe(0);
    expect(ex.observations.messages.filter((m) => m.to === PHONE)).toHaveLength(1); // the confirmation
    expect(ex.latency.perTurnMs).toHaveLength(1);
    expect(ex.latency.totalMs).toBeGreaterThanOrEqual(0);
    expect(ex.llm.calls).toBe(4);
    expect(ex.llm.perCallMs).toHaveLength(4);
    expect(ex.llm.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(ex.transcript.map((t) => t.role)).toEqual(["patient", "agent"]);
    expect(ex.promptVersion).toMatch(/^v\d{3}\+[0-9a-f]{7}$/);
  });

  it("a never-offered slot is rejected by the gate: holds = 0 and the call is observed as an error", async () => {
    const llm = new FakeLLM([
      toolUseTurn(toolUse(TOOL_NAMES.hold, { start: FIRST_SLOT, type: "cleaning" })),
      finalTurn("não consegui"),
    ]);
    const ex = await runCase(
      baseCase({
        category: "injection",
        expect: { writes: { holds: 0, bookings: 0, calendarEvents: 0 } },
      }),
      {
        pool,
        llm,
        mode: "fake",
      },
    );
    expect(ex.observations.writes.holds).toBe(0);
    expect(ex.observations.toolCalls).toEqual([
      { name: TOOL_NAMES.hold, input: { start: FIRST_SLOT, type: "cleaning" }, ok: false },
    ]);
    expect(ex.observations.heldStarts).toEqual([]);
    expect(ex.observations.status).toBe("active");
  });

  it("a tool error inside the script still completes with observations (no throw)", async () => {
    const llm = new FakeLLM([
      toolUseTurn(toolUse(TOOL_NAMES.availability, RANGE)),
      toolUseTurn(toolUse(TOOL_NAMES.confirm, { hold_id: "MISSING", patient_name: "Ana Teste" })),
      finalTurn("ops"),
    ]);
    const ex = await runCase(baseCase(), { pool, llm, mode: "fake" });
    expect(ex.errors).toEqual([]);
    expect(ex.observations.toolCalls.map((c) => c.ok)).toEqual([true, false]);
    expect(ex.observations.writes.bookings).toBe(0);
  });

  it("an infrastructure throw (e.g. exhausted script) is recorded as an error, never as a result", async () => {
    const ex = await runCase(baseCase(), { pool, llm: new FakeLLM([]), mode: "fake" });
    expect(ex.errors).toHaveLength(1);
    expect(ex.errors[0].kind).toBe("infrastructure");
    expect(ex.errors[0].message).toMatch(/script exhausted/);
    expect(ex.observations.status).toBe("active");
  });

  it("seeds consent and counts a confirm attempted without opt-in as blocked (writesWithoutConsent stays 0)", async () => {
    const c = baseCase({
      seed: {
        now: NOW,
        capacity: [{ weekday: 1, start: "09:00", end: "18:00", capacity: 2 }],
        consent: "none",
      },
    });
    const ex = await runCase(c, { pool, llm: bookingScript(), mode: "fake" });
    expect(ex.observations.writes.bookings).toBe(0);
    expect(ex.observations.writesWithoutConsent).toBe(0);
    expect(ex.observations.toolCalls.at(-1)).toMatchObject({ name: TOOL_NAMES.confirm, ok: false });
    expect(ex.observations.status).toBe("active");
  });

  it("triage escalations are observed with their reason and the LLM is never called", async () => {
    const c = baseCase({
      category: "out_of_scope",
      turns: [{ text: "estou com muita dor" }],
      labels: { shouldEscalate: true, escalationReason: "urgency" },
      expect: { escalation: { expected: true } },
    });
    const ex = await runCase(c, { pool, llm: new FakeLLM([]), mode: "fake" });
    expect(ex.errors).toEqual([]);
    expect(ex.llm.calls).toBe(0);
    expect(ex.observations.escalations).toEqual([{ reason: "urgency" }]);
    expect(ex.observations.writes.escalations).toBe(1);
    expect(ex.observations.status).toBe("escalated");
    // The committed reception notice is flushed from the outbox BEFORE the patient reply (FR-214).
    expect(ex.transcript.map((t) => t.role)).toEqual(["patient", "reception", "agent"]);
  });

  it("seeded bookings make a slot full; seeded holds of another phone are exposed to the script", async () => {
    const seen: CaseContext[] = [];
    const c = baseCase({
      seed: {
        now: NOW,
        capacity: [{ weekday: 1, start: "09:00", end: "18:00", capacity: 1 }],
        bookings: [
          { start: FIRST_SLOT, phone: "+5531900000102", status: "confirmed" },
          { start: "2026-06-15T15:00:00Z", phone: "+5531900000103", status: "held" },
        ],
        consent: "opted_in",
      },
    });
    const ex = await runCase(c, {
      pool,
      llm: (ctx) => {
        seen.push(ctx);
        return new FakeLLM([toolUseTurn(toolUse(TOOL_NAMES.availability, RANGE)), finalTurn("ok")]);
      },
      mode: "fake",
    });
    expect(seen[0].otherConversationHoldId).toMatch(/\S/);
    expect(seen[0].foreignPhone).toBe(FOREIGN_PHONE);
    expect(ex.observations.offeredSlots).not.toContain(FIRST_SLOT); // full (confirmed)
    expect(ex.observations.offeredSlots).not.toContain("2026-06-15T15:00:00.000Z"); // held by someone else
    expect(ex.observations.offeredSlots).toContain("2026-06-15T14:30:00.000Z");
  });

  it("turn delayMs advances the clock between turns (a hold expires when the patient is slow)", async () => {
    const c = baseCase({
      turns: [{ text: "quero marcar" }, { text: "o primeiro", delayMs: 11 * 60 * 1000 }],
      llmScript: [[{ text: "x" }], [{ text: "x" }]],
    });
    const llm = new FakeLLM([
      toolUseTurn(toolUse(TOOL_NAMES.availability, RANGE)),
      toolUseTurn(toolUse(TOOL_NAMES.hold, { start: FIRST_SLOT, type: "cleaning" })),
      finalTurn("reservei; confirma?"),
      (i) =>
        toolUseTurn(
          toolUse(TOOL_NAMES.confirm, {
            hold_id: lastHoldId(i.messages),
            patient_name: "Ana Teste",
          }),
        ),
      finalTurn("expirou"),
    ]);
    const ex = await runCase(c, { pool, llm, mode: "fake" });
    expect(ex.latency.perTurnMs).toHaveLength(2);
    expect(ex.observations.writes).toMatchObject({ holds: 1, bookings: 0 });
    expect(ex.observations.toolCalls.at(-1)).toMatchObject({ name: TOOL_NAMES.confirm, ok: false });
  });
});

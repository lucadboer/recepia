import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  FakeLLM,
  type ScriptedTurn,
  toolUse,
  toolUseTurn,
} from "../../src/adapters/fakes/fake-llm";
import { recordConsent } from "../../src/agent/consent";
import { handleInbound } from "../../src/agent/orchestrator";
import { reply } from "../../src/agent/reply";
import { buildSystemPrompt } from "../../src/agent/system-prompt";
import { TOOL_NAMES } from "../../src/agent/tool-schemas";
import type { InboundMessage } from "../../src/agent/types";
import { CLINIC_TIMEZONE, DEFAULT_AGENT_BUDGET_USD } from "../../src/config";
import type { Pool } from "../../src/db/pool";
import { DbConversationStore } from "../../src/db/repositories/conversation-repo";
import type { LlmContent, LlmTurnResult } from "../../src/ports/llm-port";
import { AGENT_NOW, DAY_END, lastHoldId, makeAgent, RECEPTION } from "../helpers/agent";
import { ensureSchema, resetDb, seedRule, testPool } from "../helpers/db";

// T525 — usage accumulates per conversation and a budget stops the model before it overspends
// (FR-509, FR-510); the stable prompt prefix is handed to the adapter for caching (FR-511).

const PHONE = "+5531900000171";
const FIRST_SLOT = "2026-06-15T14:00:00.000Z";
// 10k input + 1k output on claude-sonnet-5-5 = 0.02 + 0.01 = US$ 0.03 per call.
const USAGE = { inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
const PRICED = { model: "claude-sonnet-5-5", provider: "anthropic", usage: USAGE };

let pool: Pool;
beforeAll(async () => {
  pool = testPool();
  await ensureSchema(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await resetDb(pool);
  await seedRule(pool, { weekday: 1, startTime: "09:00", endTime: "18:00", capacity: 2 });
});

const priced = (t: LlmTurnResult): LlmTurnResult => ({ ...t, ...PRICED });
const pricedFn =
  (
    f: (i: Parameters<Extract<ScriptedTurn, (...a: never[]) => unknown>>[0]) => LlmTurnResult,
  ): ScriptedTurn =>
  (i) => ({ ...f(i), ...PRICED });
const text = (t: string): LlmTurnResult => ({
  stopReason: "end_turn",
  content: [{ type: "text", text: t } as LlmContent],
});
const inbound = (t: string, id: string): InboundMessage => ({
  phone: PHONE,
  text: t,
  providerMessageId: id,
});
const availability = () =>
  toolUseTurn(
    toolUse(TOOL_NAMES.availability, {
      from: AGENT_NOW.toISOString(),
      to: DAY_END,
      type: "cleaning",
    }),
  );
const hold = () => toolUseTurn(toolUse(TOOL_NAMES.hold, { start: FIRST_SLOT, type: "cleaning" }));

async function lastEscalation(): Promise<Record<string, unknown> | undefined> {
  const { rows } = await pool.query(
    "SELECT payload FROM audit_log WHERE action = 'escalated' ORDER BY created_at DESC LIMIT 1",
  );
  return rows[0]?.payload;
}

describe("per-conversation budget", () => {
  it("stops before the call that would exceed the budget and hands off with budget_exceeded", async () => {
    const llm = new FakeLLM([
      priced(availability()),
      priced(hold()),
      priced(text("nunca chamado")),
    ]);
    const h = makeAgent(pool, llm);
    h.deps.budgetUsd = 0.05;

    const r = await handleInbound(h.deps, inbound("quero marcar uma limpeza", "b1"));

    expect(llm.callCount).toBe(2); // 0.06 ≥ 0.05 after the second call → no third call
    expect(r.status).toBe("escalated");
    const esc = await lastEscalation();
    expect(esc?.reason).toBe("budget_exceeded");
    expect(esc?.costUsd).toBeCloseTo(0.06, 6);
    expect(esc?.budgetUsd).toBe(0.05);
    expect(esc?.promptVersion).toBe(llm.receivedInputs[0].promptVersion);
    expect(h.messaging.sent.filter((m) => m.to === PHONE).map((m) => m.body)).toEqual([
      reply.escalatedToReception(),
    ]);
    expect(h.messaging.sent.filter((m) => m.to === RECEPTION)).toHaveLength(1);
    const state = await h.conversations.load(PHONE);
    expect(state?.status).toBe("escalated");
    expect(state?.usage).toMatchObject({
      inputTokens: 20_000,
      outputTokens: 2_000,
      calls: 2,
      models: ["claude-sonnet-5-5"],
    });
    expect(state?.usage.costUsd).toBeCloseTo(0.06, 6);
  });

  it("a later turn of an already over-budget conversation never calls the model", async () => {
    const llm = new FakeLLM([priced(availability()), priced(text("Tenho 11h. Serve?"))]);
    const h = makeAgent(pool, llm);
    h.deps.budgetUsd = 0.06;
    await handleInbound(h.deps, inbound("quero marcar", "b2-1")); // 2 calls → 0.06
    expect(llm.callCount).toBe(2);
    const r = await handleInbound(h.deps, inbound("pode ser", "b2-2"));
    expect(r.status).toBe("escalated");
    expect(llm.callCount).toBe(2);
    expect((await lastEscalation())?.reason).toBe("budget_exceeded");
  });

  it("when the turn already committed a confirmation, it ends normally — the booking is done, no hand-off", async () => {
    const llm = new FakeLLM([
      priced(availability()),
      priced(hold()),
      pricedFn((i) =>
        toolUseTurn(
          toolUse(TOOL_NAMES.confirm, {
            hold_id: lastHoldId(i.messages),
            patient_name: "Ana Teste",
          }),
        ),
      ),
      priced(text("nunca chamado")),
    ]);
    const h = makeAgent(pool, llm);
    h.deps.budgetUsd = 0.08;
    await recordConsent(h.deps, PHONE);

    const r = await handleInbound(h.deps, inbound("quero marcar", "b3"));

    expect(llm.callCount).toBe(3);
    expect(r.status).toBe("replied");
    expect(await lastEscalation()).toBeUndefined();
    const toPatient = h.messaging.sent.filter((m) => m.to === PHONE);
    expect(toPatient).toHaveLength(1);
    expect(toPatient[0].body).toContain("confirmada");
    expect((await h.conversations.load(PHONE))?.status).toBe("completed");
  });

  it("usage resets when a completed conversation starts fresh", async () => {
    const llm = new FakeLLM([
      priced(availability()),
      priced(hold()),
      pricedFn((i) =>
        toolUseTurn(
          toolUse(TOOL_NAMES.confirm, {
            hold_id: lastHoldId(i.messages),
            patient_name: "Ana Teste",
          }),
        ),
      ),
      priced(text("Até breve!")),
      priced(text("Olá de novo!")),
    ]);
    const h = makeAgent(pool, llm);
    await recordConsent(h.deps, PHONE);
    await handleInbound(h.deps, inbound("quero marcar", "b4-1"));
    expect((await h.conversations.load(PHONE))?.usage.calls).toBe(4);
    await handleInbound(h.deps, inbound("oi de novo", "b4-2"));
    const usage = (await h.conversations.load(PHONE))?.usage;
    expect(usage?.calls).toBe(1);
    expect(usage?.costUsd).toBeCloseTo(0.03, 6);
  });

  it("defaults to US$ 0.25, ignores unpriced zero-usage fakes and passes the cacheable prefix", async () => {
    expect(DEFAULT_AGENT_BUDGET_USD).toBe(0.25);
    const llm = new FakeLLM([text("Oi!")]); // model "scripted", zero usage → no pricing lookup
    const h = makeAgent(pool, llm);
    await handleInbound(h.deps, inbound("oi", "b5"));
    const state = await h.conversations.load(PHONE);
    expect(state?.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      calls: 1,
      models: ["scripted"],
    });
    const prompt = buildSystemPrompt({ now: AGENT_NOW, timezone: CLINIC_TIMEZONE });
    expect(llm.receivedInputs[0].systemCacheablePrefix).toBe(prompt.cacheablePrefixLength);
  });
});

describe("usage persistence", () => {
  it("DbConversationStore reads a legacy row without usage as zeros", async () => {
    const legacy = {
      phone: PHONE,
      status: "active",
      history: [],
      offeredSlots: [],
      activeHoldIds: [],
      lastConfirmedBookingId: null,
      processedInboundIds: [],
      patientName: null,
      awaitingConsent: false,
      escalatedAt: null,
      handoffNoticeAt: null,
      promptVersion: null,
      updatedAt: AGENT_NOW.toISOString(),
    };
    await pool.query(
      "INSERT INTO conversation_state (phone, state, version, updated_at) VALUES ($1, $2, 1, now())",
      [PHONE, JSON.stringify(legacy)],
    );
    const state = await new DbConversationStore(pool).load(PHONE);
    expect(state?.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      calls: 0,
      models: [],
    });
  });
});

describe("review fixes — budget cannot be bypassed", () => {
  it("M1: a served model with no price is charged at the table's highest rate (fail closed)", async () => {
    const llm = new FakeLLM([
      {
        ...availability(),
        usage: USAGE,
        model: "provider-alias-unpriced",
        provider: "openai-compatible",
      },
      text("Tenho 11h."),
    ]);
    const h = makeAgent(pool, llm);
    await handleInbound(h.deps, inbound("quero marcar", "f1"));
    const usage = (await h.conversations.load(PHONE))?.usage;
    // claude-opus-5-5 is the priciest entry: 10k × 4 + 1k × 20 per MTok = US$ 0.06
    expect(usage?.costUsd).toBeCloseTo(0.06, 6);
    expect(usage?.models).toContain("provider-alias-unpriced");
  });

  it("Codex P2: usage of a call that succeeded is kept when a later call throws (message stays unprocessed)", async () => {
    const llm = new FakeLLM([
      priced(availability()),
      () => {
        throw Object.assign(new Error("overloaded"), { status: 529 });
      },
      priced(text("Tenho 11h.")),
    ]);
    const h = makeAgent(pool, llm);
    await expect(handleInbound(h.deps, inbound("quero marcar", "f2"))).rejects.toThrow(
      "overloaded",
    );
    const after = await h.conversations.load(PHONE);
    expect(after?.usage.calls).toBe(1);
    expect(after?.usage.costUsd).toBeCloseTo(0.03, 6);
    expect(after?.processedInboundIds).not.toContain("f2"); // a provider retry still runs the turn
    expect(after?.history).toHaveLength(0);
    // The retry runs and its spend adds up on top.
    const r = await handleInbound(h.deps, inbound("quero marcar", "f2"));
    expect(r.status).toBe("replied");
    expect((await h.conversations.load(PHONE))?.usage.calls).toBe(2);
  });
});

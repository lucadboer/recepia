import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeLLM, finalTurn, toolUse, toolUseTurn } from "../../src/adapters/fakes/fake-llm";
import { hasConsent, recordConsent } from "../../src/agent/consent";
import { handleInbound } from "../../src/agent/orchestrator";
import { reply } from "../../src/agent/reply";
import { TOOL_NAMES } from "../../src/agent/tool-schemas";
import type { InboundMessage } from "../../src/agent/types";
import { releaseConversation } from "../../src/cli/conversation-release";
import { HANDOFF_NOTICE_INTERVAL_MS } from "../../src/config";
import type { Pool } from "../../src/db/pool";
import { DbConversationStore } from "../../src/db/repositories/conversation-repo";
import { AGENT_NOW, DAY_END, lastHoldId, makeAgent, RECEPTION } from "../helpers/agent";
import { countAudit, ensureSchema, resetDb, seedRule, testPool } from "../helpers/db";

const PHONE = "+55pac";
const FIRST_SLOT = "2026-06-15T14:00:00.000Z";
const HOUR = 60 * 60 * 1000;

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

function inbound(text: string, id: string): InboundMessage {
  return { phone: PHONE, text, providerMessageId: id };
}

describe("orchestrator — handed-off state (FR-211, T237)", () => {
  it("after a triage escalation the next message gets ONE notice: no LLM call, no second reception notification", async () => {
    const llm = new FakeLLM([]); // throws if ever called
    const h = makeAgent(pool, llm);
    await handleInbound(h.deps, inbound("estou com muita dor", "m1"));
    const receptionBefore = h.messaging.sent.filter((m) => m.to === RECEPTION).length;
    const patientBefore = h.messaging.sent.filter((m) => m.to === PHONE).length;
    expect(receptionBefore).toBe(1);

    const r2 = await handleInbound(h.deps, inbound("alguém me responde?", "m2"));

    expect(r2.status).toBe("handed_off");
    expect(r2.reply).toBe(reply.handedOff());
    expect(llm.callCount).toBe(0);
    expect(h.messaging.sent.filter((m) => m.to === RECEPTION)).toHaveLength(receptionBefore);
    expect(await countAudit(pool, "escalated")).toBe(1);
    const newToPatient = h.messaging.sent.filter((m) => m.to === PHONE).slice(patientBefore);
    expect(newToPatient).toEqual([{ to: PHONE, body: reply.handedOff() }]);
    const saved = await h.conversations.load(PHONE);
    expect(saved?.status).toBe("escalated");
    expect(saved?.processedInboundIds).toContain("m2");
  });

  it("within the notice interval further messages are absorbed silently (still deduplicated)", async () => {
    const h = makeAgent(pool, new FakeLLM([]));
    await handleInbound(h.deps, inbound("estou com muita dor", "m1"));
    await handleInbound(h.deps, inbound("alguém?", "m2")); // the one notice
    const before = h.messaging.sent.length;

    const r3 = await handleInbound(h.deps, inbound("oi??", "m3"));
    const r3dup = await handleInbound(h.deps, inbound("oi??", "m3"));

    expect(r3.status).toBe("handed_off");
    expect(r3.reply).toBeUndefined();
    expect(r3dup.status).toBe("noop");
    expect(h.messaging.sent).toHaveLength(before);
    expect((await h.conversations.load(PHONE))?.processedInboundIds).toContain("m3");
  });

  it("once the notice interval elapses, exactly one more notice goes out", async () => {
    const h = makeAgent(pool, new FakeLLM([]));
    await handleInbound(h.deps, inbound("estou com muita dor", "m1"));
    await handleInbound(h.deps, inbound("alguém?", "m2")); // notice #1
    h.clock.advance(HANDOFF_NOTICE_INTERVAL_MS + 1000);
    const before = h.messaging.sent.filter((m) => m.to === PHONE).length;

    await handleInbound(h.deps, inbound("e aí?", "m3"));
    await handleInbound(h.deps, inbound("??", "m4"));

    const after = h.messaging.sent.filter((m) => m.to === PHONE);
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)?.body).toBe(reply.handedOff());
  });

  it("opt-out is honoured while handed off (LGPD): audited, replied, state stays escalated", async () => {
    const h = makeAgent(pool, new FakeLLM([]));
    await recordConsent(h.deps, PHONE);
    await handleInbound(h.deps, inbound("estou com muita dor", "m1"));
    const receptionBefore = h.messaging.sent.filter((m) => m.to === RECEPTION).length;

    const r = await handleInbound(h.deps, inbound("não quero mais receber mensagens", "m2"));

    expect(r.status).toBe("replied");
    expect(r.reply).toBe(reply.optedOut());
    expect(await hasConsent(h.deps, PHONE)).toBe(false);
    expect(await countAudit(pool, "consent_revoked")).toBe(1);
    expect(h.messaging.sent.filter((m) => m.to === RECEPTION)).toHaveLength(receptionBefore);
    expect((await h.conversations.load(PHONE))?.status).toBe("escalated");
  });

  it("the escalate_to_human tool also hands the conversation off", async () => {
    const llm = new FakeLLM([
      toolUseTurn(toolUse(TOOL_NAMES.escalate, { reason: "ambiguity", context: "x" })),
    ]);
    const h = makeAgent(pool, llm);
    await handleInbound(h.deps, inbound("quero algo", "m1"));

    const r2 = await handleInbound(h.deps, inbound("e agora?", "m2"));

    expect(r2.status).toBe("handed_off");
    expect(llm.callCount).toBe(1);
    expect(h.messaging.sent.filter((m) => m.to === RECEPTION)).toHaveLength(1);
  });

  it("release by reception → the next message starts a fresh autonomous conversation; old ids stay deduplicated", async () => {
    const h = makeAgent(pool, new FakeLLM([]));
    h.deps.conversations = new DbConversationStore(pool);
    await handleInbound(h.deps, inbound("estou com muita dor", "m1"));
    expect((await h.deps.conversations.load(PHONE))?.status).toBe("escalated");

    const released = await releaseConversation(pool, PHONE, h.clock.now());
    expect(released).toBe(true);
    expect(await countAudit(pool, "conversation_released")).toBe(1);

    const llm2 = new FakeLLM([finalTurn("Olá! Como posso ajudar?")]);
    h.deps.llm = llm2;
    const r2 = await handleInbound(h.deps, inbound("oi", "m2"));

    expect(r2.status).toBe("replied");
    expect(llm2.callCount).toBe(1);
    expect(llm2.receivedInputs[0].messages).toHaveLength(1); // fresh history
    const saved = await h.deps.conversations.load(PHONE);
    expect(saved?.status).toBe("active");
    expect((await handleInbound(h.deps, inbound("estou com muita dor", "m1"))).status).toBe("noop");
  });

  it("optional auto-release TTL: still handed off before it elapses, autonomous again after", async () => {
    const h = makeAgent(pool, new FakeLLM([]));
    h.deps.handoffAutoReleaseMs = 2 * HOUR;
    await handleInbound(h.deps, inbound("estou com muita dor", "m1"));

    h.clock.advance(1 * HOUR);
    const r2 = await handleInbound(h.deps, inbound("alguém?", "m2"));
    expect(r2.status).toBe("handed_off");

    h.clock.advance(1 * HOUR + 1000);
    const llm3 = new FakeLLM([finalTurn("Oi! Posso ajudar a agendar?")]);
    h.deps.llm = llm3;
    const r3 = await handleInbound(h.deps, inbound("oi", "m3"));
    expect(r3.status).toBe("replied");
    expect(llm3.callCount).toBe(1);
    expect((await h.conversations.load(PHONE))?.status).toBe("active");
  });
});

describe("orchestrator — completed conversations reset (FR-212, T237)", () => {
  it("after a confirmed booking the next message starts fresh, while earlier message ids stay deduplicated", async () => {
    const llm = new FakeLLM([
      toolUseTurn(
        toolUse(TOOL_NAMES.availability, {
          from: AGENT_NOW.toISOString(),
          to: DAY_END,
          type: "cleaning",
        }),
      ),
      toolUseTurn(toolUse(TOOL_NAMES.hold, { start: FIRST_SLOT, type: "cleaning" })),
      (i) =>
        toolUseTurn(
          toolUse(TOOL_NAMES.confirm, { hold_id: lastHoldId(i.messages), patient_name: "João" }),
        ),
      finalTurn("Confirmado!"),
    ]);
    const h = makeAgent(pool, llm);
    await recordConsent(h.deps, PHONE);
    await handleInbound(h.deps, inbound("quero marcar uma limpeza", "m1"));
    expect((await h.conversations.load(PHONE))?.status).toBe("completed");

    const llm2 = new FakeLLM([finalTurn("De nada! Até lá.")]);
    h.deps.llm = llm2;
    const r2 = await handleInbound(h.deps, inbound("obrigado!", "m2"));

    expect(r2.status).toBe("replied");
    expect(llm2.receivedInputs[0].messages).toHaveLength(1); // only the new user text
    const saved = await h.conversations.load(PHONE);
    expect(saved?.status).toBe("active");
    expect(saved?.offeredSlots).toEqual([]);
    expect(saved?.activeHoldIds).toEqual([]);
    expect(saved?.processedInboundIds).toEqual(expect.arrayContaining(["m1", "m2"]));
    expect((await handleInbound(h.deps, inbound("quero marcar uma limpeza", "m1"))).status).toBe(
      "noop",
    );
    expect(h.calendar.createdCount).toBe(1); // nothing re-booked
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeLLM, finalTurn, toolUse, toolUseTurn } from "../../src/adapters/fakes/fake-llm";
import { hasConsent, recordConsent } from "../../src/agent/consent";
import { handleInbound } from "../../src/agent/orchestrator";
import { reply } from "../../src/agent/reply";
import { TOOL_NAMES } from "../../src/agent/tool-schemas";
import type { InboundMessage } from "../../src/agent/types";
import type { Pool } from "../../src/db/pool";
import { dispatchOutbox } from "../../src/jobs/dispatch-outbox";
import { AGENT_NOW, DAY_END, lastHoldId, makeAgent, RECEPTION } from "../helpers/agent";
import { countAudit, ensureSchema, resetDb, seedRule, testPool } from "../helpers/db";

const PHONE = "+55pac";

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
});

function inbound(text: string, id: string): InboundMessage {
  return { phone: PHONE, text, providerMessageId: id };
}

describe("orchestrator — opt-out fast path (LGPD)", () => {
  it("opts a consented patient out WITHOUT invoking the LLM, audited, no booking side-effects", async () => {
    // FakeLLM([]) throws if turn() is ever called — proves the fast path bypasses the LLM.
    const llm = new FakeLLM([]);
    const h = makeAgent(pool, llm);
    await recordConsent(h.deps, PHONE); // patient had previously opted in

    const r = await handleInbound(h.deps, inbound("Não quero mais receber mensagens", "o1"));

    expect(r.status).toBe("replied");
    expect(r.reply).toBe(reply.optedOut());
    expect(llm.callCount).toBe(0); // LLM never called
    expect(await hasConsent(h.deps, PHONE)).toBe(false); // flipped to opted-out
    expect(await countAudit(pool, "consent_revoked")).toBe(1);

    // No booking machinery ran; exactly one message (to the patient), none to reception.
    expect(h.calendar.createdCount).toBe(0);
    expect(h.messaging.sent).toHaveLength(1);
    expect(h.messaging.sent[0].to).toBe(PHONE);
    expect(h.messaging.sent.filter((m) => m.to === RECEPTION)).toHaveLength(0);

    const saved = await h.conversations.load(PHONE);
    expect(saved?.awaitingConsent).toBe(false);
  });

  it("opt-out CANCELS confirmations still queued for the patient — audited, never delivered [Codex P1]", async () => {
    await seedRule(pool, { weekday: 1, startTime: "09:00", endTime: "18:00", capacity: 2 });
    const llm = new FakeLLM([
      toolUseTurn(
        toolUse(TOOL_NAMES.availability, {
          from: AGENT_NOW.toISOString(),
          to: DAY_END,
          type: "cleaning",
        }),
      ),
      toolUseTurn(
        toolUse(TOOL_NAMES.hold, { start: "2026-06-15T14:00:00.000Z", type: "cleaning" }),
      ),
      (i) =>
        toolUseTurn(
          toolUse(TOOL_NAMES.confirm, { hold_id: lastHoldId(i.messages), patient_name: "João" }),
        ),
      finalTurn("Confirmado!"),
    ]);
    const h = makeAgent(pool, llm);
    await recordConsent(h.deps, PHONE);
    h.messaging.failAlways = true; // provider outage: the confirmation stays queued (retry scheduled)
    await handleInbound(h.deps, inbound("quero marcar uma limpeza", "b1"));
    const status = async () =>
      (await pool.query("SELECT status FROM outbox_message WHERE kind = 'booking_confirmation'"))
        .rows[0]?.status;
    expect(await status()).toBe("pending");

    h.messaging.failAlways = false;
    const r = await handleInbound(h.deps, inbound("não quero mais receber mensagens", "o2"));

    expect(r.status).toBe("replied");
    expect(await status()).toBe("cancelled");
    expect(await countAudit(pool, "outbox_cancelled")).toBe(1);
    const audit = await pool.query(
      "SELECT payload FROM audit_log WHERE action = 'outbox_cancelled'",
    );
    expect(audit.rows[0].payload.reason).toBe("opt_out");
    expect(audit.rows[0].payload.ids).toHaveLength(1);

    // Even when the retry comes due, nothing but the opt-out acknowledgment ever reached the patient.
    h.clock.advance(60 * 60 * 1000);
    await dispatchOutbox(h.deps);
    expect(h.messaging.sent.filter((m) => m.to === PHONE).map((m) => m.body)).toEqual([
      reply.optedOut(),
    ]);
  });
});

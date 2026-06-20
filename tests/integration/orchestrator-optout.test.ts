import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeLLM } from "../../src/adapters/fakes/fake-llm";
import { hasConsent, recordConsent } from "../../src/agent/consent";
import { handleInbound } from "../../src/agent/orchestrator";
import { reply } from "../../src/agent/reply";
import type { InboundMessage } from "../../src/agent/types";
import type { Pool } from "../../src/db/pool";
import { makeAgent, RECEPTION } from "../helpers/agent";
import { countAudit, ensureSchema, resetDb, testPool } from "../helpers/db";

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
});

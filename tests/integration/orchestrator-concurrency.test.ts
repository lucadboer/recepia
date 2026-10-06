import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { finalTurn } from "../../src/adapters/fakes/fake-llm";
import { handleInbound } from "../../src/agent/orchestrator";
import type { InboundMessage } from "../../src/agent/types";
import type { Pool } from "../../src/db/pool";
import { DbConversationStore } from "../../src/db/repositories/conversation-repo";
import { ConversationConflictError } from "../../src/domain/errors";
import type { LLMPort } from "../../src/ports/llm-port";
import { makeAgent } from "../helpers/agent";
import { ensureSchema, resetDb, seedRule, testPool } from "../helpers/db";

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
  await seedRule(pool, { weekday: 1, startTime: "09:00", endTime: "18:00", capacity: 2 });
});

function inbound(text: string, id: string): InboundMessage {
  return { phone: PHONE, text, providerMessageId: id };
}

describe("orchestrator × DbConversationStore — no lost update under concurrency (T240)", () => {
  it("two turns for the SAME phone racing from the same loaded state: one wins, one fails with ConversationConflictError", async () => {
    // Barrier: both turns must have loaded state (and reached the LLM) before either saves.
    let arrived = 0;
    let open!: () => void;
    const gate = new Promise<void>((r) => {
      open = r;
    });
    const llm: LLMPort = {
      async turn() {
        arrived++;
        if (arrived === 2) open();
        await gate;
        return finalTurn("olá");
      },
    };
    const h = makeAgent(pool, llm);
    h.deps.conversations = new DbConversationStore(pool);

    const results = await Promise.allSettled([
      handleInbound(h.deps, inbound("oi", "m1")),
      handleInbound(h.deps, inbound("tudo bem?", "m2")),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConversationConflictError);
    expect(String(rejected[0].reason.message)).not.toContain(PHONE); // phone is masked in the error

    // Exactly one turn persisted; the losing one neither overwrote state nor messaged the patient.
    const saved = await h.deps.conversations.load(PHONE);
    expect(saved?.processedInboundIds).toHaveLength(1);
    expect(saved?.version).toBe(1);
    expect(h.messaging.sent.filter((m) => m.to === PHONE)).toHaveLength(1);
  });

  it("sequential turns for the same phone chain versions 1 → 2 → 3", async () => {
    const llm: LLMPort = { turn: async () => finalTurn("ok") };
    const h = makeAgent(pool, llm);
    h.deps.conversations = new DbConversationStore(pool);
    await handleInbound(h.deps, inbound("a", "m1"));
    await handleInbound(h.deps, inbound("b", "m2"));
    await handleInbound(h.deps, inbound("c", "m3"));
    const saved = await h.deps.conversations.load(PHONE);
    expect(saved?.version).toBe(3);
    expect(saved?.processedInboundIds).toEqual(["m1", "m2", "m3"]);
  });
});

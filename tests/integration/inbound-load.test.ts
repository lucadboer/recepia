import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ZERO_USAGE } from "../../src/adapters/fakes/fake-llm";
import { recordConsent } from "../../src/agent/consent";
import { handleInbound } from "../../src/agent/orchestrator";
import type { Pool } from "../../src/db/pool";
import type { LLMPort, LlmMessage } from "../../src/ports/llm-port";
import { createDurableEnqueue } from "../../src/webhook/enqueue";
import { makeAgent } from "../helpers/agent";
import { ensureSchema, resetDb, testPool } from "../helpers/db";
import { startPipeline } from "../helpers/pipeline";

// T809 / T811 (008) — under load through the real webhook → store → worker → orchestrator path:
// every message is processed once, in the order each phone sent it, never two of a phone at once;
// a flood from one phone is capped without touching the others.

const SECRET = "load-secret";
const PHONES = Array.from({ length: 10 }, (_, i) => `+55319000008${String(i).padStart(2, "0")}`);
const PER_PHONE = 20;

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

function lastUserText(messages: LlmMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    for (const c of m.content) if (c.type === "text") return c.text;
  }
  return "";
}

const post = (base: string, phone: string, id: string, text: string) =>
  fetch(`${base}/webhook/evolution/${SECRET}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: SECRET },
    body: JSON.stringify({
      event: "messages.upsert",
      data: {
        key: { remoteJid: `${phone.slice(1)}@s.whatsapp.net`, fromMe: false, id },
        message: { conversation: text },
      },
    }),
  });

describe("durable inbound pipeline under load", () => {
  it("4 workers × 200 messages × 10 phones: all processed once, in order per phone, never concurrently per phone", async () => {
    const seen = new Map<string, number[]>();
    const llm: LLMPort = {
      model: "scripted",
      provider: "fake",
      async turn(input) {
        const [, phone, n] = lastUserText(input.messages).split(" ");
        seen.set(phone, [...(seen.get(phone) ?? []), Number(n)]);
        return {
          stopReason: "end_turn",
          content: [{ type: "text", text: "ok" }],
          usage: ZERO_USAGE,
        };
      },
    };
    const h = makeAgent(pool, llm);
    for (const p of PHONES) await recordConsent(h.deps, p);
    const active = new Map<string, number>();
    let overlap = false;
    const pipeline = await startPipeline(h.deps, {
      secret: SECRET,
      handler: async (m) => {
        const a = (active.get(m.phone) ?? 0) + 1;
        active.set(m.phone, a);
        if (a > 1) overlap = true;
        try {
          return await handleInbound(h.deps, m);
        } finally {
          active.set(m.phone, (active.get(m.phone) ?? 1) - 1);
        }
      },
    });
    try {
      // Each phone sends its messages in order; the phones send at the same time.
      const statuses = await Promise.all(
        PHONES.map(async (p) => {
          const codes: number[] = [];
          for (let n = 0; n < PER_PHONE; n++) {
            codes.push((await post(pipeline.base, p, `${p}-${n}`, `msg ${p} ${n}`)).status);
          }
          return codes;
        }),
      );
      expect(statuses.flat().every((c) => c === 200)).toBe(true);
      const deadline = Date.now() + 30_000;
      for (;;) {
        const { rows } = await pool.query(
          "SELECT count(*)::int AS n FROM inbound_message WHERE status = 'done'",
        );
        if (rows[0].n === PHONES.length * PER_PHONE) break;
        if (Date.now() > deadline) throw new Error(`only ${rows[0].n} processed`);
        await new Promise((r) => setTimeout(r, 25));
      }
    } finally {
      await pipeline.stop();
    }
    expect(overlap).toBe(false);
    for (const p of PHONES) {
      expect(seen.get(p)).toEqual(Array.from({ length: PER_PHONE }, (_, n) => n));
    }
  }, 60_000);

  it("a flood from one phone is capped (20 queued, the rest dropped) and other phones are unaffected", async () => {
    const h = makeAgent(pool, {
      model: "x",
      provider: "fake",
      turn: async () => ({ stopReason: "end_turn", content: [] }),
    });
    const enqueue = createDurableEnqueue({ pool, clock: h.deps.clock }); // no worker: rows stay open
    for (let i = 0; i < 25; i++) {
      await enqueue({ phone: PHONES[0], text: "spam", providerMessageId: `f${i}` }, "evolution");
    }
    await enqueue({ phone: PHONES[1], text: "oi", providerMessageId: "other" }, "evolution");
    const { rows } = await pool.query(
      "SELECT phone, status, count(*)::int AS n FROM inbound_message GROUP BY phone, status ORDER BY phone, status",
    );
    expect(rows).toEqual([
      { phone: PHONES[0], status: "dropped", n: 5 },
      { phone: PHONES[0], status: "pending", n: 20 },
      { phone: PHONES[1], status: "pending", n: 1 },
    ]);
  });
});

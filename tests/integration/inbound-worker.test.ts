import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../src/adapters/fakes/fake-clock";
import type { InboundMessage } from "../../src/agent/types";
import type { Pool } from "../../src/db/pool";
import { insertInbound } from "../../src/db/repositories/inbound-repo";
import { createInboundWorker, inboundBackoff } from "../../src/jobs/inbound-worker";
import { countAudit, ensureSchema, resetDb, testPool } from "../helpers/db";

// T802 / T807 / T810 (008) — the worker drives the queue: one turn per claimed message, in order
// per phone, retries with jitter, a dead letter after the last attempt, and a clean drain.

const NOW = new Date("2026-06-15T12:00:00Z");
const RECEPTION = "+5511999999999";

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

async function put(phone: string, id: string): Promise<void> {
  const client = await pool.connect();
  try {
    await insertInbound(
      client,
      { phone, text: `t-${id}`, providerMessageId: id, receivedAt: NOW },
      "evolution",
      NOW,
      20,
    );
  } finally {
    client.release();
  }
}

async function until(cond: () => Promise<boolean>, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const statusOf = async (id: string) =>
  (await pool.query("SELECT status FROM inbound_message WHERE provider_message_id = $1", [id]))
    .rows[0]?.status;

describe("inboundBackoff", () => {
  it("grows 2 s, 10 s, 30 s, 2 min, 10 min with ±20 % jitter and stays at the last step", () => {
    const base = [2_000, 10_000, 30_000, 120_000, 600_000];
    for (const [i, b] of base.entries()) {
      expect(inboundBackoff(i + 1, () => 0)).toBe(Math.round(b * 0.8));
      expect(inboundBackoff(i + 1, () => 1)).toBe(Math.round(b * 1.2));
    }
    expect(inboundBackoff(9, () => 0.5)).toBe(600_000);
  });
});

describe("createInboundWorker", () => {
  it("processes every message once, in order per phone, never two of one phone at a time", async () => {
    const seen: string[] = [];
    let inFlight = new Set<string>();
    let overlap = false;
    const worker = createInboundWorker({
      pool,
      clock: new FakeClock(NOW),
      receptionPhone: RECEPTION,
      concurrency: 4,
      pollMs: 10,
      handler: async (m: InboundMessage) => {
        if (inFlight.has(m.phone)) overlap = true;
        inFlight.add(m.phone);
        await new Promise((r) => setTimeout(r, 5));
        seen.push(m.providerMessageId);
        inFlight = new Set([...inFlight].filter((p) => p !== m.phone));
      },
    });
    for (let i = 0; i < 5; i++) {
      await put("+5531900000811", `a${i}`);
      await put("+5531900000812", `b${i}`);
    }
    worker.start();
    await until(async () => seen.length === 10);
    await worker.drain(1_000);
    expect(seen.filter((x) => x.startsWith("a"))).toEqual(["a0", "a1", "a2", "a3", "a4"]);
    expect(seen.filter((x) => x.startsWith("b"))).toEqual(["b0", "b1", "b2", "b3", "b4"]);
    expect(overlap).toBe(false);
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM inbound_message WHERE status = 'done' AND body IS NULL",
    );
    expect(rows[0].n).toBe(10);
  });

  it("wake() starts work immediately without waiting for the poll", async () => {
    const seen: string[] = [];
    const worker = createInboundWorker({
      pool,
      clock: new FakeClock(NOW),
      receptionPhone: RECEPTION,
      pollMs: 60_000,
      handler: async (m) => {
        seen.push(m.providerMessageId);
      },
    });
    worker.start();
    await new Promise((r) => setTimeout(r, 20));
    await put("+5531900000813", "w1");
    worker.wake();
    await until(async () => seen.length === 1, 1_000);
    await worker.drain(1_000);
  });

  it("retries a failing turn later, and after the last attempt dead-letters it to reception", async () => {
    const clock = new FakeClock(NOW);
    let calls = 0;
    const worker = createInboundWorker({
      pool,
      clock,
      receptionPhone: RECEPTION,
      pollMs: 5,
      maxAttempts: 3,
      handler: async () => {
        calls++;
        throw new TypeError("boom");
      },
    });
    await put("+5531900000814", "f1");
    await put("+5531900000814", "f2"); // must still be processed after f1 dies
    worker.start();
    await until(async () => (await statusOf("f1")) === "pending" && calls === 1);
    clock.advance(10 * 60_000); // past any backoff
    worker.wake();
    await until(async () => calls === 2);
    clock.advance(10 * 60_000);
    worker.wake();
    await until(async () => (await statusOf("f1")) === "dead");
    expect(await countAudit(pool, "inbound_dead_letter")).toBe(1);
    const esc = await pool.query("SELECT to_phone FROM outbox_message WHERE kind = 'escalation'");
    expect(esc.rows).toEqual([{ to_phone: RECEPTION }]);
    await until(async () => (await statusOf("f2")) !== "pending" || calls >= 4);
    await worker.drain(1_000);
    expect(calls).toBeGreaterThanOrEqual(4); // f2 was attempted after f1 died
  });

  it("drain() waits for the turns in flight and stops claiming", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const worker = createInboundWorker({
      pool,
      clock: new FakeClock(NOW),
      receptionPhone: RECEPTION,
      pollMs: 5,
      handler: async () => {
        await gate;
      },
    });
    await put("+5531900000815", "d1");
    await put("+5531900000816", "d2");
    worker.start();
    await until(async () => (await statusOf("d1")) === "processing");
    const drained = worker.drain(2_000);
    setTimeout(release, 30);
    expect(await drained).toBe(true);
    expect(await statusOf("d1")).toBe("done");
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../src/adapters/fakes/fake-clock";
import { emptyState } from "../../src/agent/conversation";
import type { InboundMessage } from "../../src/agent/types";
import { makePool, type Pool } from "../../src/db/pool";
import { DbConversationStore } from "../../src/db/repositories/conversation-repo";
import { insertInbound } from "../../src/db/repositories/inbound-repo";
import { AttemptsExhaustedError, LeaseLostError } from "../../src/domain/errors";
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

  it("retries a failing turn later; after the last attempt and a recovery pass it dead-letters to reception", async () => {
    const clock = new FakeClock(NOW);
    const runs: Record<string, string[]> = {};
    const worker = createInboundWorker({
      pool,
      clock,
      receptionPhone: RECEPTION,
      pollMs: 5,
      maxAttempts: 3,
      handler: async (m, _lease, opts) => {
        const r = runs[m.providerMessageId] ?? [];
        runs[m.providerMessageId] = r;
        r.push(opts?.recoverOnly ? "recover" : "turn");
        throw new TypeError("boom");
      },
    });
    await put("+5531900000814", "f1");
    await put("+5531900000814", "f2"); // must still be processed after f1 dies
    worker.start();
    await until(async () => (await statusOf("f1")) === "pending" && runs.f1?.length === 1);
    clock.advance(10 * 60_000); // past any backoff
    worker.wake();
    await until(async () => runs.f1?.length === 2);
    clock.advance(10 * 60_000);
    worker.wake();
    await until(async () => (await statusOf("f1")) === "dead");
    // Three turns, then one recovery pass (nothing to recover: it throws) before the dead letter.
    expect(runs.f1).toEqual(["turn", "turn", "turn", "recover"]);
    expect(await countAudit(pool, "inbound_dead_letter")).toBe(1);
    const esc = await pool.query("SELECT to_phone FROM outbox_message WHERE kind = 'escalation'");
    expect(esc.rows).toEqual([{ to_phone: RECEPTION }]);
    await until(async () => (runs.f2?.length ?? 0) >= 1);
    await worker.drain(1_000);
    expect(runs.f2?.[0]).toBe("turn"); // f2 was attempted after f1 died
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

  it("a turn whose message was taken over is told to stop, and its attempt records nothing", async () => {
    await put("+5531900000811", "lost-1");
    let aborted = false;
    let fenced: unknown = null;
    const worker = createInboundWorker({
      pool,
      clock: new FakeClock(NOW),
      receptionPhone: RECEPTION,
      concurrency: 1,
      pollMs: 10,
      leaseMs: 3_000, // a heartbeat every second
      handler: async (_m, lease) => {
        await lease.fence(); // still ours
        await pool.query(
          "UPDATE inbound_message SET locked_by = 'w2/other-claim' WHERE provider_message_id = 'lost-1'",
        );
        await new Promise<void>((resolve) =>
          lease.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        aborted = true;
        fenced = await lease.fence().catch((err: unknown) => err);
        throw fenced;
      },
    });
    worker.start();
    await until(async () => aborted);
    expect(await worker.drain(2_000)).toBe(true);
    expect(fenced).toBeInstanceOf(LeaseLostError);
    const { rows } = await pool.query(
      "SELECT status, locked_by, attempts FROM inbound_message WHERE provider_message_id = 'lost-1'",
    );
    // The new holder's claim is untouched: no retry scheduled, no dead letter by the stale attempt.
    expect(rows[0]).toEqual({ status: "processing", locked_by: "w2/other-claim", attempts: 1 });
    expect(await countAudit(pool, "inbound_dead_letter")).toBe(0);
  });

  it("drain() started while a claim is in flight does not wait out the idle poll", async () => {
    // A slow claim: drain() wakes the idle waiters before this slot has registered as one.
    const slowPool = {
      query: async (text: string, values?: unknown[]) => {
        if (text.includes("SET status = 'processing'"))
          await new Promise((r) => setTimeout(r, 150));
        return pool.query(text, values);
      },
    } as unknown as Pool;
    const worker = createInboundWorker({
      pool: slowPool,
      clock: new FakeClock(NOW),
      receptionPhone: RECEPTION,
      concurrency: 1,
      pollMs: 10_000,
      handler: async () => {},
    });
    worker.start();
    await new Promise((r) => setTimeout(r, 30)); // the first claim is in flight
    const t0 = Date.now();
    expect(await worker.drain(2_000)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("a turn that never settles is bounded: its attempt is retried and its slot freed", async () => {
    await put("+5531900000821", "stuck-1");
    await put("+5531900000822", "next-1");
    const seen: string[] = [];
    let staleSignal: AbortSignal | null = null;
    const worker = createInboundWorker({
      pool,
      clock: new FakeClock(NOW),
      receptionPhone: RECEPTION,
      concurrency: 1,
      pollMs: 10,
      turnTimeoutMs: 100,
      turnGraceMs: 50, // this one never settles at all
      handler: async (m, lease) => {
        seen.push(m.providerMessageId);
        if (m.providerMessageId === "stuck-1") {
          staleSignal = lease.signal;
          await new Promise(() => {}); // a provider call that never returns
        }
      },
    });
    worker.start();
    await until(async () => (await statusOf("next-1")) === "done");
    await worker.drain(1_000);
    expect(seen).toContain("next-1"); // the only slot was freed
    const { rows } = await pool.query(
      "SELECT status, locked_by, last_error FROM inbound_message WHERE provider_message_id = 'stuck-1'",
    );
    expect(rows[0]).toEqual({
      status: "pending",
      locked_by: null, // the stalled attempt's lease token is void: its writes are fenced
      last_error: "InboundTurnTimeoutError",
    });
    expect((staleSignal as AbortSignal | null)?.aborted).toBe(true);
  });

  it("a message whose turns kept crashing is only recovered, never run again; nothing to recover → reception", async () => {
    await put("+5531900000823", "crashy-1");
    await put("+5531900000824", "crashy-2");
    // Five attempts were claimed and their processes died mid-turn: the lease expired each time.
    await pool.query(
      `UPDATE inbound_message SET status = 'processing', attempts = 5, locked_by = 'dead/1',
         locked_until = $1 WHERE provider_message_id IN ('crashy-1', 'crashy-2')`,
      [new Date(NOW.getTime() - 1)],
    );
    const modes: [string, boolean][] = [];
    const worker = createInboundWorker({
      pool,
      clock: new FakeClock(NOW),
      receptionPhone: RECEPTION,
      concurrency: 1,
      pollMs: 10,
      maxAttempts: 5,
      handler: async (m, _lease, opts) => {
        modes.push([m.providerMessageId, opts?.recoverOnly === true]);
        // As the orchestrator does: crashy-1's turn had committed (recovered), crashy-2's had not.
        if (m.providerMessageId === "crashy-2") throw new AttemptsExhaustedError();
      },
    });
    worker.start();
    await until(async () => (await statusOf("crashy-2")) === "dead");
    await worker.drain(1_000);
    expect(modes).toEqual([
      ["crashy-1", true],
      ["crashy-2", true],
    ]);
    expect(await statusOf("crashy-1")).toBe("done");
    expect(await countAudit(pool, "inbound_dead_letter")).toBe(1);
    expect(await countAudit(pool, "escalated")).toBe(1);
  });

  it("a timed-out turn stuck on a lock inside its fenced save cannot strand its message", async () => {
    const phone = "+5531900000825";
    const tight = makePool(undefined, { lockTimeoutMs: 300 });
    const store = new DbConversationStore(tight);
    await store.save(emptyState(phone, NOW));
    // Another transaction holds the conversation row (as a dead-letter or a release might).
    const blocker = await pool.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT 1 FROM conversation_state WHERE phone = $1 FOR UPDATE", [phone]);
    try {
      await put(phone, "locked-1");
      const worker = createInboundWorker({
        pool: tight,
        clock: new FakeClock(NOW),
        receptionPhone: RECEPTION,
        concurrency: 1,
        pollMs: 10,
        turnTimeoutMs: 100,
        turnGraceMs: 2_000,
        handler: async (_m, lease) => {
          // The fenced save holds the message row FOR SHARE, then waits on the conversation row.
          const loaded = await store.load(phone);
          await store.save(loaded as NonNullable<typeof loaded>, {
            fence: (tx) => lease.fence(tx),
          });
        },
      });
      worker.start();
      // The lock wait is bounded by the database, so the timed-out attempt can still be finished.
      const retried = async () =>
        (
          await pool.query(
            "SELECT status, last_error FROM inbound_message WHERE provider_message_id = 'locked-1'",
          )
        ).rows[0];
      await until(async () => (await retried())?.last_error === "InboundTurnTimeoutError", 3_000);
      expect(await worker.drain(1_000)).toBe(true);
      expect((await retried()).status).toBe("pending");
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await tight.end();
    }
  });

  it("a timed-out turn's in-flight effects settle before another attempt may run the message", async () => {
    await put("+5531900000826", "slow-1");
    let statusWhenSettled: string | undefined;
    const worker = createInboundWorker({
      pool,
      clock: new FakeClock(NOW),
      receptionPhone: RECEPTION,
      concurrency: 1,
      pollMs: 10,
      turnTimeoutMs: 100,
      turnGraceMs: 2_000,
      handler: async (m) => {
        if (m.providerMessageId !== "slow-1") return;
        // A compensating Calendar delete already under way: the abort cannot cancel it.
        await new Promise((r) => setTimeout(r, 400));
        statusWhenSettled = await statusOf("slow-1");
        throw new Error("compensated");
      },
    });
    worker.start();
    await until(async () => statusWhenSettled !== undefined);
    await until(async () => (await statusOf("slow-1")) === "pending");
    await worker.drain(1_000);
    // Not retryable while the stalled attempt was still acting on what a retry would reuse.
    expect(statusWhenSettled).toBe("processing");
  });

  it("the last attempt's committed work is recovered instead of dead-lettered", async () => {
    await put("+5531900000827", "last-1");
    const modes: boolean[] = [];
    const worker = createInboundWorker({
      pool,
      clock: new FakeClock(NOW),
      receptionPhone: RECEPTION,
      concurrency: 1,
      pollMs: 10,
      maxAttempts: 1,
      handler: async (_m, _lease, opts) => {
        modes.push(opts?.recoverOnly === true);
        // The turn committed (say, an escalation), then failed before saving the conversation.
        if (!opts?.recoverOnly) throw new Error("save failed after the commit");
      },
    });
    worker.start();
    await until(async () => (await statusOf("last-1")) === "done");
    await worker.drain(1_000);
    expect(modes).toEqual([false, true]); // one turn, then one recovery pass — no second turn
    expect(await countAudit(pool, "inbound_dead_letter")).toBe(0);
  });
});

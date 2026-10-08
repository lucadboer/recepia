import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "../../src/db/pool";
import {
  claimNext,
  heartbeat,
  insertInbound,
  markDead,
  markDone,
  markRetry,
} from "../../src/db/repositories/inbound-repo";
import { countAudit, ensureSchema, resetDb, testPool } from "../helpers/db";

// T803 (008, contract inbound-queue.md) — the queue's guarantees, straight against Postgres.

const NOW = new Date("2026-06-15T12:00:00Z");
const LEASE = 5 * 60_000;
const A = "+5531900000801";
const B = "+5531900000802";
const RECEPTION = "+5511999999999";

/** Narrow a value the test just asserted exists (no non-null assertions). */
function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error("expected a value");
  return v;
}

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

async function put(
  phone: string,
  id: string,
  at = NOW,
  provider: "evolution" | "cloud" = "evolution",
) {
  const client = await pool.connect();
  try {
    return await insertInbound(
      client,
      { phone, text: `msg ${id}`, providerMessageId: id, receivedAt: at },
      provider,
      at,
      20,
    );
  } finally {
    client.release();
  }
}

async function rows(): Promise<
  { provider_message_id: string; status: string; body: string | null }[]
> {
  const r = await pool.query(
    "SELECT provider_message_id, status, body FROM inbound_message ORDER BY id",
  );
  return r.rows;
}

describe("insertInbound", () => {
  it("stores a message once per provider id; a redelivery is a duplicate", async () => {
    expect(await put(A, "m1")).toBe("inserted");
    expect(await put(A, "m1")).toBe("duplicate");
    expect(await put(A, "m1", NOW, "cloud")).toBe("inserted"); // another provider, another key
    expect(await rows()).toHaveLength(2);
  });

  it("beyond the per-phone limit new messages are stored as dropped, other phones unaffected", async () => {
    const client = await pool.connect();
    try {
      for (let i = 0; i < 4; i++) {
        await insertInbound(
          client,
          { phone: A, text: "x", providerMessageId: `a${i}`, receivedAt: NOW },
          "evolution",
          NOW,
          3,
        );
      }
      expect(
        await insertInbound(
          client,
          { phone: B, text: "x", providerMessageId: "b0", receivedAt: NOW },
          "evolution",
          NOW,
          3,
        ),
      ).toBe("inserted");
    } finally {
      client.release();
    }
    expect((await rows()).map((r) => r.status)).toEqual([
      "pending",
      "pending",
      "pending",
      "dropped",
      "pending",
    ]);
  });
});

describe("claimNext — FIFO per phone, one in flight per phone", () => {
  it("claims the oldest message of a phone and never a second one of the same phone while it runs", async () => {
    await put(A, "a1");
    await put(A, "a2");
    await put(B, "b1");
    const first = await claimNext(pool, "w1", NOW, LEASE);
    const second = await claimNext(pool, "w2", NOW, LEASE);
    const third = await claimNext(pool, "w3", NOW, LEASE);
    expect([first?.providerMessageId, second?.providerMessageId]).toEqual(["a1", "b1"]);
    expect(third).toBeNull(); // a2 waits for a1
    await markDone(pool, must(first).id, "w1", NOW);
    expect((await claimNext(pool, "w3", NOW, LEASE))?.providerMessageId).toBe("a2");
  });

  it("concurrent claimers never take two messages of one phone", async () => {
    for (let i = 0; i < 6; i++) await put(A, `a${i}`);
    for (let i = 0; i < 6; i++) await put(B, `b${i}`);
    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, i) => claimNext(pool, `w${i}`, NOW, LEASE)),
    );
    const got = claims.filter((c) => c !== null).map((c) => must(c).phone);
    expect(got.sort()).toEqual([A, B]);
  });

  it("respects the due time of a retried message", async () => {
    await put(A, "a1");
    const c = await claimNext(pool, "w1", NOW, LEASE);
    await markRetry(pool, must(c).id, "w1", new Date(NOW.getTime() + 10_000), "Error");
    expect(await claimNext(pool, "w2", NOW, LEASE)).toBeNull();
    expect(
      (await claimNext(pool, "w2", new Date(NOW.getTime() + 10_001), LEASE))?.providerMessageId,
    ).toBe("a1");
  });

  it("reclaims a message whose worker stopped once the lease expired; the old holder cannot finish it", async () => {
    await put(A, "a1");
    const c = await claimNext(pool, "dead-worker", NOW, LEASE);
    expect(await claimNext(pool, "w2", new Date(NOW.getTime() + LEASE - 1), LEASE)).toBeNull();
    const later = new Date(NOW.getTime() + LEASE + 1);
    const again = await claimNext(pool, "w2", later, LEASE);
    expect(again?.id).toBe(must(c).id);
    expect(again?.attempts).toBe(2);
    expect(await markDone(pool, must(c).id, "dead-worker", later)).toBe(false);
    expect(await markDone(pool, must(c).id, "w2", later)).toBe(true);
  });

  it("a heartbeat extends the lease of the holder only", async () => {
    await put(A, "a1");
    const c = await claimNext(pool, "w1", NOW, LEASE);
    const soon = new Date(NOW.getTime() + LEASE - 1_000);
    expect(await heartbeat(pool, must(c).id, "w1", soon, LEASE)).toBe(true);
    expect(await heartbeat(pool, must(c).id, "intruder", soon, LEASE)).toBe(false);
    expect(await claimNext(pool, "w2", new Date(NOW.getTime() + LEASE + 1), LEASE)).toBeNull();
  });
});

describe("finishing a message", () => {
  it("done clears the text", async () => {
    await put(A, "a1");
    const c = await claimNext(pool, "w1", NOW, LEASE);
    await markDone(pool, must(c).id, "w1", NOW);
    expect(await rows()).toEqual([{ provider_message_id: "a1", status: "done", body: null }]);
  });

  it("dead = row + audit + one reception hand-off in one step; the phone's next message proceeds", async () => {
    await put(A, "a1");
    await put(A, "a2");
    const c = await claimNext(pool, "w1", NOW, LEASE);
    expect(await markDead(pool, must(c).id, "w1", NOW, "TypeError", RECEPTION)).toBe(true);
    expect((await rows())[0]).toMatchObject({ status: "dead", body: null });
    expect(await countAudit(pool, "inbound_dead_letter")).toBe(1);
    expect(await countAudit(pool, "escalated")).toBe(1);
    const esc = await pool.query("SELECT to_phone FROM outbox_message WHERE kind = 'escalation'");
    expect(esc.rows).toEqual([{ to_phone: RECEPTION }]);
    expect((await claimNext(pool, "w2", NOW, LEASE))?.providerMessageId).toBe("a2");
  });
});

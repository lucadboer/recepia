import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeCalendar } from "../../src/adapters/fakes/fake-calendar";
import { FakeClock } from "../../src/adapters/fakes/fake-clock";
import { FakeMessaging } from "../../src/adapters/fakes/fake-messaging";
import { HOLD_TTL_MS } from "../../src/config";
import type { Pool } from "../../src/db/pool";
import type { Deps } from "../../src/deps";
import { expireHolds } from "../../src/jobs/expire-holds";
import { holdSlot } from "../../src/tools/hold-slot";
import {
  countActiveHolds,
  countAudit,
  ensureSchema,
  resetDb,
  seedRule,
  testPool,
} from "../helpers/db";

const NOW = new Date("2026-06-15T12:00:00Z");
const SLOT = new Date("2026-06-15T14:00:00Z");
const OTHER_SLOT = new Date("2026-06-15T15:00:00Z");
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
  await seedRule(pool, { weekday: 1, startTime: "09:00", endTime: "18:00", capacity: 2 });
});

function makeDeps(clock: FakeClock, p: Pool = pool): Deps {
  return {
    pool: p,
    clock,
    calendar: new FakeCalendar(),
    messaging: new FakeMessaging(),
    receptionPhone: RECEPTION,
  };
}

async function statusOf(id: string): Promise<string> {
  const { rows } = await pool.query("SELECT status FROM booking WHERE id = $1", [id]);
  return rows[0].status;
}

describe("expireHolds — the scheduled sweep (T245)", () => {
  it("expires every due hold, leaves fresh ones, and audits exactly one hold_expired per id", async () => {
    const clock = new FakeClock(NOW);
    const d = makeDeps(clock);
    const a = await holdSlot(d, { start: SLOT, type: "cleaning" }, { phone: "+55a" });
    const b = await holdSlot(d, { start: OTHER_SLOT, type: "cleaning" }, { phone: "+55b" });
    clock.advance(HOLD_TTL_MS - 60_000); // 1 min before a/b expire
    const fresh = await holdSlot(d, { start: SLOT, type: "cleaning" }, { phone: "+55c" });
    clock.advance(120_000); // a and b are due; `fresh` has ~8 min left

    const expired = await expireHolds(d);

    expect(expired).toBe(2);
    expect(await statusOf(a.id)).toBe("expired");
    expect(await statusOf(b.id)).toBe("expired");
    expect(await statusOf(fresh.id)).toBe("held");
    expect(await countAudit(pool, "hold_expired")).toBe(2);
    const audited = await pool.query(
      "SELECT entity_id FROM audit_log WHERE action = 'hold_expired' ORDER BY entity_id",
    );
    expect(audited.rows.map((r) => r.entity_id).sort()).toEqual([a.id, b.id].sort());
    expect(await countActiveHolds(pool, SLOT, clock.now())).toBe(1);
  });

  it("is a no-op when nothing is due", async () => {
    const clock = new FakeClock(NOW);
    const d = makeDeps(clock);
    await holdSlot(d, { start: SLOT, type: "cleaning" }, { phone: "+55a" });
    expect(await expireHolds(d)).toBe(0);
    expect(await countAudit(pool, "hold_expired")).toBe(0);
  });

  it("race with the lazy reclaim: audits only what IT expired — never a duplicate hold_expired [T234]", async () => {
    const clock = new FakeClock(NOW);
    const real = makeDeps(clock);
    const victim = await holdSlot(real, { start: SLOT, type: "cleaning" }, { phone: "+55a" });
    clock.advance(HOLD_TTL_MS + 1000); // victim is due

    // Right before the sweep's UPDATE runs, another request lazily reclaims the same slot
    // (holdSlot expires `victim` and audits hold_expired itself, in its own transaction).
    let raced = false;
    const racingPool = interceptingPool(pool, async (sql) => {
      // Match the sweep's UPDATE only (a SELECT-then-UPDATE sweep would double-audit here).
      if (
        !raced &&
        sql.startsWith("UPDATE booking SET status = 'expired'") &&
        sql.includes("expires_at <= $1")
      ) {
        raced = true;
        await holdSlot(real, { start: SLOT, type: "cleaning" }, { phone: "+55late" });
      }
    });

    const expired = await expireHolds(makeDeps(clock, racingPool));

    expect(raced).toBe(true);
    expect(expired).toBe(0); // the lazy reclaim won
    expect(await statusOf(victim.id)).toBe("expired");
    // Exactly ONE hold_expired for the victim (from the lazy reclaim), not two.
    const audited = await pool.query(
      "SELECT entity_id FROM audit_log WHERE action = 'hold_expired'",
    );
    expect(audited.rows.map((r) => r.entity_id)).toEqual([victim.id]);
  });
});

type AnyQuery = (...a: unknown[]) => unknown;

/** Runs `before(sql)` ahead of every statement on clients checked out through the wrapper; restores on release. */
function interceptingPool(real: Pool, before: (sql: string) => Promise<void>): Pool {
  return {
    query: (...args: unknown[]) => (real as unknown as { query: AnyQuery }).query(...args),
    async connect() {
      const client = await real.connect();
      const mutable = client as unknown as { query: AnyQuery; release: AnyQuery };
      const origQuery = mutable.query.bind(client);
      const origRelease = mutable.release.bind(client);
      mutable.query = async (...args: unknown[]) => {
        const sql =
          typeof args[0] === "string" ? args[0] : ((args[0] as { text?: string })?.text ?? "");
        await before(sql);
        return origQuery(...args);
      };
      mutable.release = (...args: unknown[]) => {
        mutable.query = origQuery;
        mutable.release = origRelease;
        return origRelease(...args);
      };
      return client;
    },
  } as unknown as Pool;
}

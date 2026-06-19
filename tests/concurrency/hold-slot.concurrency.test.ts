import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeCalendar } from "../../src/adapters/fakes/fake-calendar";
import { FakeClock } from "../../src/adapters/fakes/fake-clock";
import { FakeMessaging } from "../../src/adapters/fakes/fake-messaging";
import type { Pool } from "../../src/db/pool";
import type { Deps } from "../../src/deps";
import { SlotUnavailableError } from "../../src/domain/errors";
import { holdSlot } from "../../src/tools/hold-slot";
import { countActiveHolds, ensureSchema, resetDb, seedRule, testPool } from "../helpers/db";

const NOW = new Date("2026-06-15T12:00:00Z"); // Monday 09:00 local
const SLOT = new Date("2026-06-15T14:00:00Z"); // Monday 11:00 local (>= now + 2h)
const CAPACITY = 2;

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
  await seedRule(pool, { weekday: 1, startTime: "09:00", endTime: "18:00", capacity: CAPACITY });
});

function deps(): Deps {
  return {
    pool,
    clock: new FakeClock(NOW),
    calendar: new FakeCalendar(),
    messaging: new FakeMessaging(),
    receptionPhone: "+5511999999999",
  };
}

describe("hold_slot — concurrency (no overbooking) [MANDATORY GATE]", () => {
  it("N simultaneous holds on one slot never exceed capacity", async () => {
    const N = 16;
    const d = deps();

    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        holdSlot(d, { start: SLOT, type: "cleaning" }, { phone: `+5500000000${i}` }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(CAPACITY);
    expect(rejected).toHaveLength(N - CAPACITY);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(SlotUnavailableError);
    }

    // Ground truth in the DB: never more than capacity active holds.
    expect(await countActiveHolds(pool, SLOT, NOW)).toBe(CAPACITY);
  });
});

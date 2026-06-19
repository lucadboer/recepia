import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeCalendar } from "../../src/adapters/fakes/fake-calendar";
import { FakeClock } from "../../src/adapters/fakes/fake-clock";
import { FakeMessaging } from "../../src/adapters/fakes/fake-messaging";
import type { Pool } from "../../src/db/pool";
import type { Deps } from "../../src/deps";
import { toLocalParts } from "../../src/domain/time";
import { findNextSlots } from "../../src/tools/alternatives";
import { ensureSchema, resetDb, seedConfirmed, seedRule, testPool } from "../helpers/db";

const NOW = new Date("2026-06-15T12:00:00Z"); // Monday 09:00 local

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
  // capacity 1 so a single confirmed booking fills a slot
  for (let wd = 1; wd <= 5; wd++) {
    await seedRule(pool, { weekday: wd, startTime: "09:00", endTime: "18:00", capacity: 1 });
  }
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

describe("findNextSlots (US2 — real alternatives when the requested period is full)", () => {
  it("offers the next real free slots when the requested window is full", async () => {
    // requested window 11:00–12:00 local = [14:00Z, 15:00Z): slots 11:00 and 11:30
    await seedConfirmed(pool, "2026-06-15T14:00:00.000Z", "+55a");
    await seedConfirmed(pool, "2026-06-15T14:30:00.000Z", "+55b");

    const slots = await findNextSlots(
      deps(),
      { from: new Date("2026-06-15T14:00:00Z"), to: new Date("2026-06-15T15:00:00Z") },
      "cleaning",
      3,
    );

    expect(slots).toHaveLength(3);
    const starts = slots.map((s) => s.start.toISOString());
    expect(starts).not.toContain("2026-06-15T14:00:00.000Z");
    expect(starts).not.toContain("2026-06-15T14:30:00.000Z");
    expect(starts[0]).toBe("2026-06-15T15:00:00.000Z"); // 12:00 local — the next free slot

    for (const s of slots) {
      const lp = toLocalParts(s.start);
      expect(lp.minutesOfDay % 30).toBe(0);
      expect(lp.minutesOfDay).toBeGreaterThanOrEqual(9 * 60);
      expect(lp.minutesOfDay + 30).toBeLessThanOrEqual(18 * 60);
    }
  });

  it("returns slots from the requested window itself when it has capacity", async () => {
    const slots = await findNextSlots(
      deps(),
      { from: new Date("2026-06-15T14:00:00Z"), to: new Date("2026-06-15T15:00:00Z") },
      "cleaning",
      5,
    );
    // 11:00 and 11:30 are free → returned directly
    expect(slots.map((s) => s.start.toISOString())).toContain("2026-06-15T14:00:00.000Z");
  });
});

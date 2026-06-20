import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeCalendar } from "../../src/adapters/fakes/fake-calendar";
import { FakeClock } from "../../src/adapters/fakes/fake-clock";
import { FakeMessaging } from "../../src/adapters/fakes/fake-messaging";
import type { Pool } from "../../src/db/pool";
import type { Deps } from "../../src/deps";
import { toLocalParts } from "../../src/domain/time";
import { getAvailability } from "../../src/tools/get-availability";
import { ensureSchema, resetDb, seedConfirmed, seedHeld, seedRule, testPool } from "../helpers/db";

const NOW = new Date("2026-06-15T12:00:00Z"); // Monday 09:00 local; now+2h = 11:00 local
const SLOT_AT_11 = "2026-06-15T14:00:00.000Z"; // Monday 11:00 local

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
  for (let wd = 1; wd <= 5; wd++) {
    await seedRule(pool, { weekday: wd, startTime: "09:00", endTime: "18:00", capacity: 2 });
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

describe("get_availability", () => {
  it("offers only grid-aligned slots within business hours and the [now+2h, now+30d] horizon", async () => {
    const slots = await getAvailability(
      deps(),
      { from: NOW, to: new Date("2026-06-16T00:00:00Z") },
      "cleaning",
    );

    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      const lp = toLocalParts(s.start);
      expect(lp.minutesOfDay % 30).toBe(0); // 30-min grid
      expect(lp.minutesOfDay).toBeGreaterThanOrEqual(9 * 60); // >= 09:00
      expect(lp.minutesOfDay + 30).toBeLessThanOrEqual(18 * 60); // fits before 18:00
      expect(s.start.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + 2 * 3600_000); // >= now+2h
      expect(s.end.getTime() - s.start.getTime()).toBe(30 * 60_000);
    }
    expect(slots[0].start.toISOString()).toBe(SLOT_AT_11); // earliest = now + 2h
  });

  it("returns nothing for a slot whose capacity is exhausted", async () => {
    await seedConfirmed(pool, SLOT_AT_11, "+55a", 0);
    await seedConfirmed(pool, SLOT_AT_11, "+55b", 1); // capacity 2 reached

    const slots = await getAvailability(
      deps(),
      { from: NOW, to: new Date("2026-06-15T15:00:00Z") },
      "cleaning",
    );
    const starts = slots.map((s) => s.start.toISOString());
    expect(starts).not.toContain(SLOT_AT_11);
    expect(starts).toContain("2026-06-15T14:30:00.000Z"); // next slot still free
  });

  it("honors an override that closes the day (capacity 0)", async () => {
    await pool.query(
      "INSERT INTO capacity_override (date, start_time, end_time, capacity) VALUES ('2026-06-15','00:00','23:59',0)",
    );
    const slots = await getAvailability(
      deps(),
      { from: NOW, to: new Date("2026-06-16T00:00:00Z") },
      "cleaning",
    );
    const monday = slots.filter((s) => toLocalParts(s.start).dateStr === "2026-06-15");
    expect(monday).toHaveLength(0);
  });

  it("counts an active hold against capacity but ignores an expired one", async () => {
    const future = new Date(NOW.getTime() + 5 * 60_000);
    await seedHeld(pool, SLOT_AT_11, "+55a", future, 0);
    await seedHeld(pool, SLOT_AT_11, "+55b", future, 1); // 2 active holds -> full

    let slots = await getAvailability(
      deps(),
      { from: NOW, to: new Date("2026-06-15T14:30:00Z") },
      "cleaning",
    );
    expect(slots.map((s) => s.start.toISOString())).not.toContain(SLOT_AT_11);

    // Expired holds must not count.
    await resetDb(pool);
    for (let wd = 1; wd <= 5; wd++) {
      await seedRule(pool, { weekday: wd, startTime: "09:00", endTime: "18:00", capacity: 2 });
    }
    const past = new Date(NOW.getTime() - 60_000);
    await seedHeld(pool, SLOT_AT_11, "+55a", past, 0);
    await seedHeld(pool, SLOT_AT_11, "+55b", past, 1);

    slots = await getAvailability(
      deps(),
      { from: NOW, to: new Date("2026-06-15T14:30:00Z") },
      "cleaning",
    );
    expect(slots.map((s) => s.start.toISOString())).toContain(SLOT_AT_11);
  });

  it("returns an empty list when the only slot in the period is fully booked", async () => {
    await seedConfirmed(pool, SLOT_AT_11, "+55a", 0);
    await seedConfirmed(pool, SLOT_AT_11, "+55b", 1); // capacity 2 reached

    const slots = await getAvailability(
      deps(),
      { from: NOW, to: new Date("2026-06-15T14:30:00Z") }, // only the 11:00 slot is in range
      "cleaning",
    );
    expect(slots).toEqual([]);
  });

  it("never offers a slot at or beyond now+30d (horizon upper bound)", async () => {
    const sixtyDays = new Date(NOW.getTime() + 60 * 24 * 3600_000);
    const slots = await getAvailability(deps(), { from: NOW, to: sixtyDays }, "cleaning");
    const horizonEnd = NOW.getTime() + 30 * 24 * 3600_000;

    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      expect(s.start.getTime()).toBeLessThan(horizonEnd);
    }
  });
});

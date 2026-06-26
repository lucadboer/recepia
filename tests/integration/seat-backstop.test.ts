import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeCalendar } from "../../src/adapters/fakes/fake-calendar";
import { FakeClock } from "../../src/adapters/fakes/fake-clock";
import { FakeMessaging } from "../../src/adapters/fakes/fake-messaging";
import { HOLD_TTL_MS } from "../../src/config";
import type { Pool } from "../../src/db/pool";
import { getById } from "../../src/db/repositories/booking-repo";
import type { Deps } from "../../src/deps";
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
const SLOT = new Date("2026-06-15T14:00:00Z"); // Monday 11:00 local
const END = new Date("2026-06-15T14:30:00Z");

let pool: Pool;

beforeAll(async () => {
  pool = testPool();
  await ensureSchema(pool);
});
afterAll(async () => {
  await pool.end();
});

function makeDeps(clock: FakeClock): Deps {
  return {
    pool,
    clock,
    calendar: new FakeCalendar(),
    messaging: new FakeMessaging(),
    receptionPhone: "+5511999999999",
  };
}

async function seatOf(id: string): Promise<number> {
  const { rows } = await pool.query("SELECT seat FROM booking WHERE id = $1", [id]);
  return rows[0].seat;
}

describe("seat model — STRUCTURAL no-overbooking backstop", () => {
  beforeEach(async () => {
    await resetDb(pool);
    await seedRule(pool, { weekday: 1, startTime: "09:00", endTime: "18:00", capacity: 2 });
  });

  it("the DB unique(slot, seat) index rejects an overbooking that BYPASSES the advisory lock", async () => {
    const d = makeDeps(new FakeClock(NOW));
    const a = await holdSlot(d, { start: SLOT, type: "cleaning" }, { phone: "+55a" }); // seat 0
    const b = await holdSlot(d, { start: SLOT, type: "cleaning" }, { phone: "+55b" }); // seat 1
    expect([await seatOf(a.id), await seatOf(b.id)].sort()).toEqual([0, 1]);

    // Bypass hold_slot entirely (NO advisory lock) and try to exceed capacity by
    // inserting a third active booking — it must reuse a seat in [0, capacity) and
    // the partial unique index has to reject it.
    await expect(
      pool.query(
        `INSERT INTO booking (patient_phone, appointment_type, start_ts, end_ts, status, created_via, seat)
         VALUES ('+55intruder', 'cleaning', $1, $2, 'confirmed', 'ai', 0)`,
        [SLOT, END],
      ),
    ).rejects.toThrow(/duplicate key value violates unique constraint/i);

    expect(await countActiveHolds(pool, SLOT, NOW)).toBe(2); // still capped
  });

  it("lazily reclaims an expired hold's seat for a new hold WITHOUT the sweeper job", async () => {
    await resetDb(pool);
    await seedRule(pool, { weekday: 1, startTime: "09:00", endTime: "18:00", capacity: 1 });

    const clock = new FakeClock(NOW);
    const d = makeDeps(clock);
    const a = await holdSlot(d, { start: SLOT, type: "cleaning" }, { phone: "+55a" }); // seat 0
    expect(await seatOf(a.id)).toBe(0);

    clock.advance(HOLD_TTL_MS + 1000); // a's hold is now past its TTL

    // No expireHolds() call here — hold_slot must reclaim a's seat on its own.
    const b = await holdSlot(d, { start: SLOT, type: "cleaning" }, { phone: "+55b" });
    expect(await seatOf(b.id)).toBe(0); // reused the freed seat

    const aAfter = await getById(pool, a.id);
    expect(aAfter?.status).toBe("expired"); // reclaimed to terminal state
  });

  it("audits the lazy reclaim (held -> expired) inside holdSlot's transaction [T228]", async () => {
    await resetDb(pool);
    await seedRule(pool, { weekday: 1, startTime: "09:00", endTime: "18:00", capacity: 1 });

    const clock = new FakeClock(NOW);
    const d = makeDeps(clock);
    await holdSlot(d, { start: SLOT, type: "cleaning" }, { phone: "+55a" }); // seat 0
    clock.advance(HOLD_TTL_MS + 1000); // a's hold is now past its TTL

    // A new hold on the same slot triggers the lazy reclaim of a's expired hold.
    await holdSlot(d, { start: SLOT, type: "cleaning" }, { phone: "+55b" });

    // Constitution V: EVERY write to booking is audited — the lazy reclaim included
    // (the sweep already audits hold_expired; the lazy path must too).
    expect(await countAudit(pool, "hold_expired")).toBe(1);
  });
});

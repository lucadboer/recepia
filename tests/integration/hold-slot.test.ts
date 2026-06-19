import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeCalendar } from "../../src/adapters/fakes/fake-calendar";
import { FakeClock } from "../../src/adapters/fakes/fake-clock";
import { FakeMessaging } from "../../src/adapters/fakes/fake-messaging";
import { HOLD_TTL_MS } from "../../src/config";
import type { Pool } from "../../src/db/pool";
import { getById } from "../../src/db/repositories/booking-repo";
import type { Deps } from "../../src/deps";
import { SlotUnavailableError } from "../../src/domain/errors";
import { expireHolds } from "../../src/jobs/expire-holds";
import { holdSlot } from "../../src/tools/hold-slot";
import {
  countActiveHolds,
  countAudit,
  ensureSchema,
  resetDb,
  seedConfirmed,
  seedRule,
  testPool,
} from "../helpers/db";

const NOW = new Date("2026-06-15T12:00:00Z");
const SLOT = new Date("2026-06-15T14:00:00Z"); // Monday 11:00 local

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

function makeDeps(clock: FakeClock): Deps {
  return {
    pool,
    clock,
    calendar: new FakeCalendar(),
    messaging: new FakeMessaging(),
    receptionPhone: "+5511999999999",
  };
}

describe("hold_slot", () => {
  it("creates a hold with created_via='ai', a 10-min TTL, and a hold_created audit row", async () => {
    const d = makeDeps(new FakeClock(NOW));
    const hold = await holdSlot(d, { start: SLOT, type: "cleaning" }, { phone: "+55a" });

    expect(hold.expiresAt.getTime()).toBe(NOW.getTime() + HOLD_TTL_MS);
    const booking = await getById(pool, hold.id);
    expect(booking?.status).toBe("held");
    expect(booking?.createdVia).toBe("ai");
    expect(await countAudit(pool, "hold_created")).toBe(1);
  });

  it("is idempotent for the same patient + slot (no duplicate hold)", async () => {
    const d = makeDeps(new FakeClock(NOW));
    const first = await holdSlot(d, { start: SLOT, type: "cleaning" }, { phone: "+55a" });
    const second = await holdSlot(d, { start: SLOT, type: "cleaning" }, { phone: "+55a" });

    expect(second.id).toBe(first.id);
    expect(await countActiveHolds(pool, SLOT, NOW)).toBe(1);
    expect(await countAudit(pool, "hold_created")).toBe(1);
  });

  it("rejects a hold on a full slot with SlotUnavailableError", async () => {
    await seedConfirmed(pool, SLOT.toISOString(), "+55x");
    await seedConfirmed(pool, SLOT.toISOString(), "+55y"); // capacity 2 reached
    const d = makeDeps(new FakeClock(NOW));

    await expect(
      holdSlot(d, { start: SLOT, type: "cleaning" }, { phone: "+55a" }),
    ).rejects.toBeInstanceOf(SlotUnavailableError);
  });

  it("frees the seat after the hold expires (sweep job + hold_expired audit)", async () => {
    const clock = new FakeClock(NOW);
    const d = makeDeps(clock);
    await holdSlot(d, { start: SLOT, type: "cleaning" }, { phone: "+55a" });
    await holdSlot(d, { start: SLOT, type: "cleaning" }, { phone: "+55b" }); // slot full (cap 2)

    await expect(
      holdSlot(d, { start: SLOT, type: "cleaning" }, { phone: "+55c" }),
    ).rejects.toBeInstanceOf(SlotUnavailableError);

    clock.advance(HOLD_TTL_MS + 1000); // both holds now past TTL
    const expired = await expireHolds(d);
    expect(expired).toBe(2);
    expect(await countAudit(pool, "hold_expired")).toBe(2);
    expect(await countActiveHolds(pool, SLOT, clock.now())).toBe(0);

    // seat is free again
    const hold = await holdSlot(d, { start: SLOT, type: "cleaning" }, { phone: "+55c" });
    expect(hold.id).toBeTruthy();
  });
});

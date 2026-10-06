import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeCalendar } from "../../src/adapters/fakes/fake-calendar";
import { FakeClock } from "../../src/adapters/fakes/fake-clock";
import { FakeMessaging } from "../../src/adapters/fakes/fake-messaging";
import type { Pool } from "../../src/db/pool";
import type { Deps } from "../../src/deps";
import { SlotUnavailableError } from "../../src/domain/errors";
import { dispatchOutbox } from "../../src/jobs/dispatch-outbox";
import { confirmBooking } from "../../src/tools/confirm-booking";
import { getAvailability } from "../../src/tools/get-availability";
import { holdSlot } from "../../src/tools/hold-slot";
import { countAudit, ensureSchema, resetDb, seedRule, testPool } from "../helpers/db";

const NOW = new Date("2026-06-15T12:00:00Z");

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

function deps(): Deps {
  return {
    pool,
    clock: new FakeClock(NOW),
    calendar: new FakeCalendar(),
    messaging: new FakeMessaging(),
    receptionPhone: "+5511999999999",
  };
}

describe("US1 end-to-end — book a routine slot with no human", () => {
  it("availability -> hold -> confirm writes one event + confirmation (Acceptance Scenario 1)", async () => {
    const d = deps();
    const slots = await getAvailability(
      d,
      { from: NOW, to: new Date("2026-06-15T18:00:00Z") },
      "cleaning",
    );
    expect(slots.length).toBeGreaterThan(0);

    const slot = slots[0];
    const hold = await holdSlot(d, { start: slot.start, type: "cleaning" }, { phone: "+55joao" });
    const { booking, outcome } = await confirmBooking(d, hold.id, {
      phone: "+55joao",
      name: "João",
    });

    expect(outcome).toBe("confirmed");
    expect(booking.status).toBe("confirmed");
    expect((d.calendar as FakeCalendar).createdCount).toBe(1);
    await dispatchOutbox(d); // the confirmation is committed with the booking, delivered by the outbox
    expect((d.messaging as FakeMessaging).sent.some((m) => m.to === "+55joao")).toBe(true);
    expect(await countAudit(pool, "hold_created")).toBeGreaterThanOrEqual(1);
    expect(await countAudit(pool, "booking_confirmed")).toBe(1);
  });

  it("a full slot turns the next patient away and alternatives are offered (Acceptance Scenario 2/3)", async () => {
    const d = deps();
    const slots = await getAvailability(
      d,
      { from: NOW, to: new Date("2026-06-15T18:00:00Z") },
      "cleaning",
    );
    const target = slots[0].start; // capacity 2

    for (const phone of ["+55a", "+55b"]) {
      const h = await holdSlot(d, { start: target, type: "cleaning" }, { phone });
      await confirmBooking(d, h.id, { phone, name: phone });
    }

    // third patient cannot hold the now-full slot
    await expect(
      holdSlot(d, { start: target, type: "cleaning" }, { phone: "+55c" }),
    ).rejects.toBeInstanceOf(SlotUnavailableError);

    // but real alternatives exist and exclude the full slot
    const after = await getAvailability(
      d,
      { from: NOW, to: new Date("2026-06-15T18:00:00Z") },
      "cleaning",
    );
    const starts = after.map((s) => s.start.toISOString());
    expect(starts).not.toContain(target.toISOString());
    expect(after.length).toBeGreaterThan(0);
  });
});

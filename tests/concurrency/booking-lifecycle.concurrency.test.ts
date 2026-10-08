import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeCalendar } from "../../src/adapters/fakes/fake-calendar";
import { FakeClock } from "../../src/adapters/fakes/fake-clock";
import { FakeMessaging } from "../../src/adapters/fakes/fake-messaging";
import type { Pool } from "../../src/db/pool";
import type { Deps } from "../../src/deps";
import { SlotUnavailableError } from "../../src/domain/errors";
import { cancelBooking } from "../../src/tools/cancel-booking";
import { confirmBooking } from "../../src/tools/confirm-booking";
import { holdSlot } from "../../src/tools/hold-slot";
import { rescheduleBooking } from "../../src/tools/reschedule-booking";
import {
  countActiveHolds,
  countAudit,
  ensureSchema,
  resetDb,
  seedRule,
  testPool,
} from "../helpers/db";

// T623 (006) [MANDATORY GATE, constitution I] — cancels and reschedules racing each other and
// racing holds never overbook a time, at most one reschedule of a booking wins, and the calendar
// ends with exactly one event per active booking (SC-602, SC-604).

const NOW = new Date("2026-06-15T12:00:00Z"); // Monday 09:00 local
const A = new Date("2026-06-17T12:00:00Z"); // Wed 09:00 local
const B = new Date("2026-06-17T13:00:00Z"); // Wed 10:00 local
const PHONE = "+5531900000660";

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
  await seedRule(pool, { weekday: 3, startTime: "09:00", endTime: "18:00", capacity: 1 });
});

function deps(calendar: FakeCalendar): Deps {
  return {
    pool,
    clock: new FakeClock(NOW),
    calendar,
    messaging: new FakeMessaging(),
    receptionPhone: "+5511999999999",
  };
}

async function book(d: Deps, start: Date, phone = PHONE): Promise<string> {
  const hold = await holdSlot(d, { start, type: "cleaning" }, { phone });
  return (await confirmBooking(d, hold.id, { phone, name: "Ana Teste" })).booking.id;
}

async function activeBookingIds(): Promise<string[]> {
  const { rows } = await pool.query(
    "SELECT id FROM booking WHERE status IN ('confirmed','patient_confirmed') ORDER BY id",
  );
  return rows.map((r) => r.id as string);
}

async function occupied(start: Date): Promise<number> {
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM booking WHERE start_ts = $1 AND status NOT IN ('cancelled','expired')",
    [start],
  );
  return rows[0].n;
}

describe("booking lifecycle — concurrency [MANDATORY GATE]", () => {
  it("10 concurrent cancels of one booking: exactly one cancellation audited and one message", async () => {
    const d = deps(new FakeCalendar());
    const id = await book(d, A);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => cancelBooking(d, id, PHONE)),
    );
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    // Every caller sees "cancelled": the one that committed and the replays, while the single
    // cancellation message is still owned by the outbox.
    const outcomes = results.map(
      (r) => (r as PromiseFulfilledResult<{ outcome: string }>).value.outcome,
    );
    expect(new Set(outcomes)).toEqual(new Set(["cancelled"]));
    expect(await countAudit(pool, "booking_cancelled")).toBe(1);
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM outbox_message WHERE kind = 'booking_cancellation'",
    );
    expect(rows[0].n).toBe(1);
  });

  it("cancel × reschedule of the same booking: one final state, events = active bookings", async () => {
    for (let round = 0; round < 5; round++) {
      await resetDb(pool);
      await seedRule(pool, { weekday: 3, startTime: "09:00", endTime: "18:00", capacity: 1 });
      const calendar = new FakeCalendar();
      const d = deps(calendar);
      const id = await book(d, A);
      const hold = await holdSlot(d, { start: B, type: "cleaning" }, { phone: PHONE });
      await Promise.allSettled([
        cancelBooking(d, id, PHONE),
        rescheduleBooking(d, id, hold.id, PHONE),
      ]);

      const active = await activeBookingIds();
      expect(active.length).toBeLessThanOrEqual(1);
      expect([...calendar.events.keys()].sort()).toEqual(active); // SC-604
      expect((await occupied(A)) + (await occupied(B))).toBe(active.length);
    }
  });

  it("16 concurrent holds on a time just freed by a cancel (capacity 1): exactly one", async () => {
    const d = deps(new FakeCalendar());
    const id = await book(d, A);
    await cancelBooking(d, id, PHONE);
    const results = await Promise.allSettled(
      Array.from({ length: 16 }, (_, i) =>
        holdSlot(
          d,
          { start: A, type: "cleaning" },
          { phone: `+55310000007${String(i).padStart(2, "0")}` },
        ),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((x) => x.status === "rejected")) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(SlotUnavailableError);
    }
    expect(await countActiveHolds(pool, A, NOW)).toBe(1);
  });

  it("several patients rescheduling into one contested time (capacity 1): never over capacity", async () => {
    const d = deps(new FakeCalendar());
    const phones = Array.from({ length: 6 }, (_, i) => `+55310000008${i}`);
    // Each patient has a booking on a different morning time and races for B.
    const morning = [8, 9, 10, 11, 12, 13].map(
      (h) => new Date(`2026-06-17T${String(h + 4).padStart(2, "0")}:30:00Z`),
    );
    const booked = await Promise.all(phones.map((p, i) => book(d, morning[i], p)));
    const holds = await Promise.allSettled(
      phones.map((p) => holdSlot(d, { start: B, type: "cleaning" }, { phone: p })),
    );
    const won = holds.flatMap((h, i) =>
      h.status === "fulfilled" ? [{ i, holdId: h.value.id }] : [],
    );
    expect(won).toHaveLength(1); // the hold already serializes the contested time
    await Promise.allSettled(
      won.map(({ i, holdId }) => rescheduleBooking(d, booked[i], holdId, phones[i])),
    );
    expect(await occupied(B)).toBe(1);
  });

  it("two reschedules of the same booking to two different times: at most one wins", async () => {
    await seedRule(pool, { weekday: 4, startTime: "09:00", endTime: "18:00", capacity: 1 });
    const calendar = new FakeCalendar();
    const d = deps(calendar);
    const id = await book(d, A);
    const h1 = await holdSlot(d, { start: B, type: "cleaning" }, { phone: PHONE });
    const h2 = await holdSlot(
      d,
      { start: new Date("2026-06-18T12:00:00Z"), type: "cleaning" },
      { phone: PHONE },
    );
    const results = await Promise.allSettled([
      rescheduleBooking(d, id, h1.id, PHONE),
      rescheduleBooking(d, id, h2.id, PHONE),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await countAudit(pool, "booking_rescheduled")).toBe(1);
    const active = await activeBookingIds();
    expect(active).toHaveLength(1);
    expect([...calendar.events.keys()].sort()).toEqual(active);
  });
});

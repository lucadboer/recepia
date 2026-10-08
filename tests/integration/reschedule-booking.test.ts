import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeCalendar } from "../../src/adapters/fakes/fake-calendar";
import { FakeClock } from "../../src/adapters/fakes/fake-clock";
import { FakeMessaging } from "../../src/adapters/fakes/fake-messaging";
import type { Pool } from "../../src/db/pool";
import { getById } from "../../src/db/repositories/booking-repo";
import type { Deps } from "../../src/deps";
import {
  BookingNotChangeableError,
  BookingNotFoundError,
  CalendarWriteError,
  HoldExpiredError,
  hasEscalatedFlag,
  InvalidRescheduleError,
} from "../../src/domain/errors";
import { cancelBooking } from "../../src/tools/cancel-booking";
import { confirmBooking } from "../../src/tools/confirm-booking";
import { getAvailability } from "../../src/tools/get-availability";
import { holdSlot } from "../../src/tools/hold-slot";
import { rescheduleBooking } from "../../src/tools/reschedule-booking";
import { countAudit, ensureSchema, resetDb, seedOverride, seedRule, testPool } from "../helpers/db";
import { interceptingPool } from "../helpers/pool";

// T616 (006, contract booking-lifecycle.md) — a reschedule is a new booking made from a hold and
// swapped in atomically: the old time is released only when the new one is confirmed.

const NOW = new Date("2026-06-15T12:00:00Z"); // Monday 09:00 local
const OLD_START = new Date("2026-06-17T12:00:00Z"); // Wed 09:00 local (48h: not late)
const NEW_START = new Date("2026-06-17T17:00:00Z"); // Wed 14:00 local
const LATE_OLD = new Date("2026-06-15T20:00:00Z"); // today 17:00 local (8h: late)
const RECEPTION = "+5511999999999";
const PHONE = "+5531900000630";
const OTHER = "+5531900000631";
const HALF_HOUR = 30 * 60_000;

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
  for (const weekday of [1, 2, 3]) {
    await seedRule(pool, { weekday, startTime: "09:00", endTime: "18:00", capacity: 1 });
  }
});

function makeDeps(calendar = new FakeCalendar(), p: Pool = pool): Deps {
  return {
    pool: p,
    clock: new FakeClock(NOW),
    calendar,
    messaging: new FakeMessaging(),
    receptionPhone: RECEPTION,
    promptVersion: "v002+test000",
  };
}

async function book(d: Deps, start: Date, phone = PHONE, type = "cleaning"): Promise<string> {
  const hold = await holdSlot(d, { start, type }, { phone });
  return (await confirmBooking(d, hold.id, { phone, name: "Ana Teste" })).booking.id;
}

async function free(d: Deps, start: Date): Promise<boolean> {
  const slots = await getAvailability(
    d,
    { from: start, to: new Date(start.getTime() + HALF_HOUR) },
    "cleaning",
  );
  return slots.length === 1;
}

async function outbox(
  kind: string,
): Promise<{ to_phone: string; body: string; dedupe_key: string }[]> {
  const r = await pool.query(
    "SELECT to_phone, body, dedupe_key FROM outbox_message WHERE kind = $1 ORDER BY created_at",
    [kind],
  );
  return r.rows;
}

describe("reschedule_booking — success", () => {
  it("swaps the seats and the calendar events and commits one 'remarcada' message", async () => {
    const calendar = new FakeCalendar();
    const d = makeDeps(calendar);
    const oldId = await book(d, OLD_START);
    const hold = await holdSlot(d, { start: NEW_START, type: "cleaning" }, { phone: PHONE });

    const r = await rescheduleBooking(d, oldId, hold.id, PHONE);

    expect(r.outcome).toBe("rescheduled");
    expect(r.late).toBe(false);
    expect(r.booking).toMatchObject({
      id: hold.id,
      status: "confirmed",
      rescheduledFrom: oldId,
      patientName: "Ana Teste",
    });
    expect((await getById(pool, oldId))?.status).toBe("cancelled");
    expect(await free(d, OLD_START)).toBe(true);
    expect(await free(d, NEW_START)).toBe(false);
    expect(calendar.events.has(hold.id)).toBe(true);
    expect(calendar.events.has(oldId)).toBe(false);
    const confirmations = await outbox("booking_confirmation");
    const mine = confirmations.filter((m) => m.dedupe_key === `booking_confirmation:${hold.id}`);
    expect(mine).toHaveLength(1);
    expect(mine[0].body).toMatch(/remarcada/);
    expect(mine[0].body).toContain("17/06/2026 às 14:00");
    expect(await outbox("reception_notice")).toHaveLength(0);
    const rescheduled = await pool.query(
      "SELECT entity_id, payload FROM audit_log WHERE action = 'booking_rescheduled'",
    );
    expect(rescheduled.rows).toHaveLength(1);
    expect(rescheduled.rows[0]).toMatchObject({ entity_id: hold.id });
    expect(rescheduled.rows[0].payload).toMatchObject({
      from: oldId,
      promptVersion: "v002+test000",
    });
    const cancelled = await pool.query(
      "SELECT entity_id, payload FROM audit_log WHERE action = 'booking_cancelled'",
    );
    expect(cancelled.rows).toEqual([
      expect.objectContaining({
        entity_id: oldId,
        payload: expect.objectContaining({ reason: "rescheduled" }),
      }),
    ]);
  });

  it("is idempotent: repeating the same reschedule writes nothing new", async () => {
    const d = makeDeps();
    const oldId = await book(d, OLD_START);
    const hold = await holdSlot(d, { start: NEW_START, type: "cleaning" }, { phone: PHONE });
    await rescheduleBooking(d, oldId, hold.id, PHONE);
    const again = await rescheduleBooking(d, oldId, hold.id, PHONE);
    expect(["rescheduled", "already_rescheduled"]).toContain(again.outcome);
    expect(await countAudit(pool, "booking_rescheduled")).toBe(1);
    expect(
      (await outbox("booking_confirmation")).filter((m) => m.dedupe_key.endsWith(hold.id)),
    ).toHaveLength(1);
  });

  it("less than 24h before the original time: reception gets a notice", async () => {
    const d = makeDeps();
    const oldId = await book(d, LATE_OLD);
    const hold = await holdSlot(d, { start: NEW_START, type: "cleaning" }, { phone: PHONE });
    const r = await rescheduleBooking(d, oldId, hold.id, PHONE);
    expect(r.late).toBe(true);
    const notices = await outbox("reception_notice");
    expect(notices.map((n) => n.dedupe_key)).toEqual([`late_change:${oldId}`]);
    expect(notices[0].body).toContain("17/06/2026 às 14:00");
  });
});

describe("reschedule_booking — the old appointment survives every failure", () => {
  it("the new event cannot be written: old intact, hold released, reception notified", async () => {
    const calendar = new FakeCalendar();
    const d = makeDeps(calendar);
    const oldId = await book(d, OLD_START);
    const hold = await holdSlot(d, { start: NEW_START, type: "cleaning" }, { phone: PHONE });
    calendar.failAlways = true;
    const err = await rescheduleBooking(d, oldId, hold.id, PHONE).catch((e) => e);
    expect(err).toBeInstanceOf(CalendarWriteError);
    expect(hasEscalatedFlag(err)).toBe(true);
    expect((await getById(pool, oldId))?.status).toBe("confirmed");
    expect(calendar.events.has(oldId)).toBe(true);
    expect((await getById(pool, hold.id))?.status).toBe("expired");
    expect(await free(d, NEW_START)).toBe(true);
    expect(await outbox("escalation")).toHaveLength(1);
  });

  it("an expired hold is refused before anything is written (the agent offers other times)", async () => {
    const calendar = new FakeCalendar();
    const d = makeDeps(calendar);
    const oldId = await book(d, OLD_START);
    const hold = await holdSlot(d, { start: NEW_START, type: "cleaning" }, { phone: PHONE });
    (d.clock as FakeClock).advance(11 * 60_000);
    await expect(rescheduleBooking(d, oldId, hold.id, PHONE)).rejects.toBeInstanceOf(
      HoldExpiredError,
    );
    expect((await getById(pool, oldId))?.status).toBe("confirmed");
    expect(calendar.createdCount).toBe(1); // only the original booking's event
  });

  it("the hold is swept after the new event was written: event compensated, old intact, escalated", async () => {
    const calendar = new FakeCalendar();
    const d = makeDeps(calendar);
    const oldId = await book(d, OLD_START);
    const hold = await holdSlot(d, { start: NEW_START, type: "cleaning" }, { phone: PHONE });
    let swept = false;
    const racing = interceptingPool(pool, {
      before: async (sql) => {
        if (!swept && sql.includes("FOR UPDATE")) {
          swept = true;
          await pool.query(
            "UPDATE booking SET status = 'expired', expires_at = NULL WHERE id = $1",
            [hold.id],
          );
        }
      },
    });
    const err = await rescheduleBooking({ ...d, pool: racing }, oldId, hold.id, PHONE).catch(
      (e) => e,
    );
    expect(hasEscalatedFlag(err)).toBe(true);
    expect((await getById(pool, oldId))?.status).toBe("confirmed");
    expect(calendar.events.has(hold.id)).toBe(false);
    expect(calendar.events.has(oldId)).toBe(true);
    expect(await countAudit(pool, "calendar_orphan_compensated")).toBe(1);
  });

  it("a concurrent cancel wins: the reschedule compensates its event and leaves one final state", async () => {
    const calendar = new FakeCalendar();
    const d = makeDeps(calendar);
    const oldId = await book(d, OLD_START);
    const hold = await holdSlot(d, { start: NEW_START, type: "cleaning" }, { phone: PHONE });
    let raced = false;
    const racing = interceptingPool(pool, {
      before: async (sql) => {
        if (!raced && sql.includes("FOR UPDATE")) {
          raced = true;
          await cancelBooking(d, oldId, PHONE);
        }
      },
    });
    const err = await rescheduleBooking({ ...d, pool: racing }, oldId, hold.id, PHONE).catch(
      (e) => e,
    );
    expect(hasEscalatedFlag(err)).toBe(true);
    expect((await getById(pool, oldId))?.status).toBe("cancelled");
    expect((await getById(pool, hold.id))?.status).toBe("expired");
    expect(calendar.events.size).toBe(0); // events = active bookings (SC-604)
  });

  it("the old event cannot be removed: reschedule stands, reception asked to remove it", async () => {
    const calendar = new FakeCalendar();
    const d = makeDeps(calendar);
    const oldId = await book(d, OLD_START);
    const hold = await holdSlot(d, { start: NEW_START, type: "cleaning" }, { phone: PHONE });
    calendar.deleteFailAlways = true;
    const r = await rescheduleBooking(d, oldId, hold.id, PHONE);
    expect(r.outcome).toBe("rescheduled");
    expect(await countAudit(pool, "calendar_delete_failed")).toBe(1);
    expect((await outbox("reception_notice")).map((n) => n.dedupe_key)).toEqual([
      `calendar_cleanup:${oldId}`,
    ]);
  });
});

describe("reschedule_booking — refusals write nothing", () => {
  it("same time, different type, foreign hold, foreign booking, past booking", async () => {
    const calendar = new FakeCalendar();
    const d = makeDeps(calendar);
    const oldId = await book(d, OLD_START);
    const otherId = await book(d, new Date("2026-06-16T12:00:00Z"), OTHER);
    const otherHold = await holdSlot(
      d,
      { start: new Date("2026-06-16T13:00:00Z"), type: "cleaning" },
      { phone: OTHER },
    );
    const evalHold = await holdSlot(
      d,
      { start: new Date("2026-06-16T14:00:00Z"), type: "evaluation" },
      { phone: PHONE },
    );
    const goodHold = await holdSlot(d, { start: NEW_START, type: "cleaning" }, { phone: PHONE });
    const created = calendar.createdCount;

    await expect(rescheduleBooking(d, oldId, evalHold.id, PHONE)).rejects.toBeInstanceOf(
      InvalidRescheduleError,
    );
    await expect(rescheduleBooking(d, oldId, otherHold.id, PHONE)).rejects.toBeInstanceOf(
      HoldExpiredError,
    );
    await expect(rescheduleBooking(d, otherId, goodHold.id, PHONE)).rejects.toBeInstanceOf(
      BookingNotFoundError,
    );

    const sameStartHold = { id: oldId }; // the booking itself is not a hold
    await expect(rescheduleBooking(d, oldId, sameStartHold.id, PHONE)).rejects.toBeInstanceOf(
      HoldExpiredError,
    );

    expect(calendar.createdCount).toBe(created);
    expect(await countAudit(pool, "booking_rescheduled")).toBe(0);
    expect((await getById(pool, oldId))?.status).toBe("confirmed");
  });

  it("moving to the very same time is refused (a second chair on that time does not make it a change)", async () => {
    await seedOverride(pool, {
      date: "2026-06-17",
      startTime: "09:00",
      endTime: "18:00",
      capacity: 2,
    });
    const d = makeDeps();
    const oldId = await book(d, OLD_START);
    const sameTime = await holdSlot(d, { start: OLD_START, type: "cleaning" }, { phone: PHONE });
    await expect(rescheduleBooking(d, oldId, sameTime.id, PHONE)).rejects.toBeInstanceOf(
      InvalidRescheduleError,
    );
    expect((await getById(pool, oldId))?.status).toBe("confirmed");
  });

  it("a cancelled booking cannot be rescheduled", async () => {
    const d = makeDeps();
    const oldId = await book(d, OLD_START);
    await cancelBooking(d, oldId, PHONE);
    const hold = await holdSlot(d, { start: NEW_START, type: "cleaning" }, { phone: PHONE });
    await expect(rescheduleBooking(d, oldId, hold.id, PHONE)).rejects.toBeInstanceOf(
      BookingNotChangeableError,
    );
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeCalendar } from "../../src/adapters/fakes/fake-calendar";
import { FakeClock } from "../../src/adapters/fakes/fake-clock";
import { FakeMessaging } from "../../src/adapters/fakes/fake-messaging";
import type { Pool } from "../../src/db/pool";
import { getById } from "../../src/db/repositories/booking-repo";
import type { Deps } from "../../src/deps";
import { BookingNotChangeableError, BookingNotFoundError } from "../../src/domain/errors";
import { cancelBooking } from "../../src/tools/cancel-booking";
import { confirmBooking } from "../../src/tools/confirm-booking";
import { findMyBooking } from "../../src/tools/find-my-booking";
import { getAvailability } from "../../src/tools/get-availability";
import { holdSlot } from "../../src/tools/hold-slot";
import { countAudit, ensureSchema, resetDb, seedBooking, seedRule, testPool } from "../helpers/db";
import { interceptingPool } from "../helpers/pool";

// T610/T611 (006, contract booking-lifecycle.md) — find the patient's single upcoming booking and
// cancel it: capacity back at once, one message, late notice, idempotent, never another patient's.

const NOW = new Date("2026-06-15T12:00:00Z"); // Monday 09:00 local
const TOMORROW_9 = new Date("2026-06-16T12:00:00Z"); // 24h ahead: not late
const TODAY_17 = new Date("2026-06-15T20:00:00Z"); // 8h ahead: late
const RECEPTION = "+5511999999999";
const PATIENT = { phone: "+5531900000620", name: "Ana Teste" };
const OTHER = "+5531900000621";

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
  for (const weekday of [1, 2]) {
    await seedRule(pool, { weekday, startTime: "09:00", endTime: "18:00", capacity: 1 });
  }
});

function makeDeps(calendar = new FakeCalendar(), clock = new FakeClock(NOW)): Deps {
  return {
    pool,
    clock,
    calendar,
    messaging: new FakeMessaging(),
    receptionPhone: RECEPTION,
    promptVersion: "v002+test000",
  };
}

/** Book through the real path (hold → confirm) so the fake calendar holds the event. */
async function book(d: Deps, start: Date, phone = PATIENT.phone): Promise<string> {
  const hold = await holdSlot(d, { start, type: "cleaning" }, { phone });
  const { booking } = await confirmBooking(d, hold.id, { phone, name: PATIENT.name });
  return booking.id;
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

describe("find_my_booking", () => {
  it("finds the single upcoming booking of this phone", async () => {
    const d = makeDeps();
    const id = await book(d, TOMORROW_9);
    const r = await findMyBooking(d, PATIENT.phone);
    expect(r.kind).toBe("found");
    expect(r.kind === "found" && r.booking.id).toBe(id);
  });

  it("none when there is nothing upcoming for this phone (other phones, past and cancelled ignored)", async () => {
    const d = makeDeps();
    await book(d, TOMORROW_9, OTHER);
    await seedBooking(pool, { start: "2026-06-14T12:00:00Z", phone: PATIENT.phone });
    await seedBooking(pool, {
      start: "2026-06-16T14:00:00Z",
      phone: PATIENT.phone,
      status: "cancelled",
    });
    expect(await findMyBooking(d, PATIENT.phone)).toEqual({ kind: "none" });
  });

  it("multiple when the patient has two upcoming bookings (SPEC US3-3: reception decides)", async () => {
    const d = makeDeps();
    await book(d, TOMORROW_9);
    await book(d, new Date("2026-06-16T14:00:00Z"));
    expect(await findMyBooking(d, PATIENT.phone)).toEqual({ kind: "multiple", count: 2 });
  });
});

describe("cancel_booking", () => {
  it("cancels, frees the time at once, removes the event, commits one message and audits", async () => {
    const calendar = new FakeCalendar();
    const d = makeDeps(calendar);
    const id = await book(d, TOMORROW_9);
    expect(calendar.events.has(id)).toBe(true);
    const before = await getAvailability(
      d,
      { from: TOMORROW_9, to: new Date(TOMORROW_9.getTime() + 30 * 60_000) },
      "cleaning",
    );
    expect(before).toHaveLength(0); // capacity 1, taken

    const r = await cancelBooking(d, id, PATIENT.phone);

    expect(r.outcome).toBe("cancelled");
    expect(r.late).toBe(false);
    expect((await getById(pool, id))?.status).toBe("cancelled");
    expect(calendar.events.has(id)).toBe(false);
    const after = await getAvailability(
      d,
      { from: TOMORROW_9, to: new Date(TOMORROW_9.getTime() + 30 * 60_000) },
      "cleaning",
    );
    expect(after.map((s) => s.start.toISOString())).toEqual([TOMORROW_9.toISOString()]); // SC-601
    const msgs = await outbox("booking_cancellation");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      to_phone: PATIENT.phone,
      dedupe_key: `booking_cancellation:${id}`,
    });
    expect(msgs[0].body).toContain("16/06/2026 às 09:00");
    expect(await outbox("reception_notice")).toHaveLength(0);
    const audit = await pool.query(
      "SELECT actor, payload FROM audit_log WHERE action = 'booking_cancelled'",
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor).toBe("ai");
    expect(audit.rows[0].payload).toMatchObject({
      reason: "patient",
      late: false,
      promptVersion: "v002+test000",
    });
  });

  it("is idempotent: a repeated call writes nothing and sends nothing", async () => {
    const d = makeDeps();
    const id = await book(d, TOMORROW_9);
    await cancelBooking(d, id, PATIENT.phone);
    const again = await cancelBooking(d, id, PATIENT.phone);
    expect(again.outcome).toBe("already_cancelled");
    expect(await countAudit(pool, "booking_cancelled")).toBe(1);
    expect(await outbox("booking_cancellation")).toHaveLength(1);
  });

  it("another patient's booking is 'not found' and nothing is written", async () => {
    const d = makeDeps();
    const id = await book(d, TOMORROW_9, OTHER);
    await expect(cancelBooking(d, id, PATIENT.phone)).rejects.toBeInstanceOf(BookingNotFoundError);
    await expect(
      cancelBooking(d, "00000000-0000-0000-0000-000000000000", PATIENT.phone),
    ).rejects.toBeInstanceOf(BookingNotFoundError);
    expect((await getById(pool, id))?.status).toBe("confirmed");
    expect(await countAudit(pool, "booking_cancelled")).toBe(0);
  });

  it("a booking that already started cannot be cancelled", async () => {
    const d = makeDeps();
    const id = await seedBooking(pool, { start: "2026-06-15T11:30:00Z", phone: PATIENT.phone });
    await expect(cancelBooking(d, id, PATIENT.phone)).rejects.toBeInstanceOf(
      BookingNotChangeableError,
    );
    expect((await getById(pool, id))?.status).toBe("confirmed");
  });

  it("less than 24h before: reception gets a notice in the same transaction", async () => {
    const d = makeDeps();
    const id = await book(d, TODAY_17);
    const r = await cancelBooking(d, id, PATIENT.phone);
    expect(r.late).toBe(true);
    const notices = await outbox("reception_notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ to_phone: RECEPTION, dedupe_key: `late_change:${id}` });
    expect(notices[0].body).toMatch(/menos de 24h/);
    expect(notices[0].body).toContain(PATIENT.phone);
  });

  it("a failure inside the transaction leaves the booking and the outbox untouched", async () => {
    const d = makeDeps();
    const id = await book(d, TOMORROW_9);
    const failing = interceptingPool(pool, {
      reject: (sql) => (sql.includes("INSERT INTO audit_log") ? new Error("boom") : null),
    });
    await expect(cancelBooking({ ...d, pool: failing }, id, PATIENT.phone)).rejects.toThrow("boom");
    expect((await getById(pool, id))?.status).toBe("confirmed");
    expect(await outbox("booking_cancellation")).toHaveLength(0);
  });

  it("an event that cannot be removed: still cancelled, failure audited, reception asked to remove it", async () => {
    const calendar = new FakeCalendar();
    const d = makeDeps(calendar);
    const id = await book(d, TOMORROW_9);
    calendar.deleteFailAlways = true;
    const r = await cancelBooking(d, id, PATIENT.phone);
    expect(r.outcome).toBe("cancelled");
    expect((await getById(pool, id))?.status).toBe("cancelled");
    expect(await countAudit(pool, "calendar_delete_failed")).toBe(1);
    const notices = await outbox("reception_notice");
    expect(notices.map((n) => n.dedupe_key)).toEqual([`calendar_cleanup:${id}`]);
    expect(notices[0].body).toMatch(/manualmente/);
  });
});

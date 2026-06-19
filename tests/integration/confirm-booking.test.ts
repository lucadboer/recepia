import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeCalendar } from "../../src/adapters/fakes/fake-calendar";
import { FakeClock } from "../../src/adapters/fakes/fake-clock";
import { FakeMessaging } from "../../src/adapters/fakes/fake-messaging";
import { HOLD_TTL_MS } from "../../src/config";
import type { Pool } from "../../src/db/pool";
import { getById } from "../../src/db/repositories/booking-repo";
import type { Deps } from "../../src/deps";
import { CalendarWriteError, HoldExpiredError } from "../../src/domain/errors";
import { confirmBooking } from "../../src/tools/confirm-booking";
import { holdSlot } from "../../src/tools/hold-slot";
import { countAudit, ensureSchema, resetDb, seedRule, testPool } from "../helpers/db";

const NOW = new Date("2026-06-15T12:00:00Z");
const SLOT = new Date("2026-06-15T14:00:00Z");
const RECEPTION = "+5511999999999";
const PATIENT = { phone: "+55a", name: "Maria Silva" };

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

function makeDeps(clock: FakeClock, calendar: FakeCalendar, messaging: FakeMessaging): Deps {
  return { pool, clock, calendar, messaging, receptionPhone: RECEPTION };
}

describe("confirm_booking", () => {
  it("writes exactly one event + one pt-BR confirmation and stamps created_via/consent_at", async () => {
    const clock = new FakeClock(NOW);
    const calendar = new FakeCalendar();
    const messaging = new FakeMessaging();
    const d = makeDeps(clock, calendar, messaging);

    const hold = await holdSlot(d, { start: SLOT, type: "cleaning" }, PATIENT);
    const booking = await confirmBooking(d, hold.id, PATIENT);

    expect(calendar.createdCount).toBe(1);
    expect(booking.status).toBe("confirmed");
    expect(booking.googleEventId).toBeTruthy();
    expect(booking.consentAt).not.toBeNull();
    expect(booking.createdVia).toBe("ai");

    expect(messaging.sent).toHaveLength(1);
    expect(messaging.sent[0].to).toBe(PATIENT.phone);
    expect(messaging.sent[0].body).toContain("confirmada");
    expect(messaging.sent[0].body).toContain("limpeza"); // pt-BR type label

    expect(await countAudit(pool, "booking_confirmed")).toBe(1);
  });

  it("fails an expired hold with HoldExpiredError and writes nothing", async () => {
    const clock = new FakeClock(NOW);
    const calendar = new FakeCalendar();
    const messaging = new FakeMessaging();
    const d = makeDeps(clock, calendar, messaging);

    const hold = await holdSlot(d, { start: SLOT, type: "cleaning" }, PATIENT);
    clock.advance(HOLD_TTL_MS + 1000);

    await expect(confirmBooking(d, hold.id, PATIENT)).rejects.toBeInstanceOf(HoldExpiredError);
    expect(calendar.attempts).toBe(0);
    expect(messaging.sent).toHaveLength(0);
    expect(await countAudit(pool, "booking_confirmed")).toBe(0);
  });

  it("is idempotent: repeating confirm does not duplicate the event or message", async () => {
    const clock = new FakeClock(NOW);
    const calendar = new FakeCalendar();
    const messaging = new FakeMessaging();
    const d = makeDeps(clock, calendar, messaging);

    const hold = await holdSlot(d, { start: SLOT, type: "cleaning" }, PATIENT);
    const first = await confirmBooking(d, hold.id, PATIENT);
    const second = await confirmBooking(d, hold.id, PATIENT);

    expect(second.id).toBe(first.id);
    expect(calendar.createdCount).toBe(1);
    expect(messaging.sent).toHaveLength(1);
  });

  it("on persistent calendar failure: retries, escalates, releases the hold, never confirms the patient", async () => {
    const clock = new FakeClock(NOW);
    const calendar = new FakeCalendar();
    calendar.failAlways = true;
    const messaging = new FakeMessaging();
    const d = makeDeps(clock, calendar, messaging);

    const hold = await holdSlot(d, { start: SLOT, type: "cleaning" }, PATIENT);
    await expect(confirmBooking(d, hold.id, PATIENT)).rejects.toBeInstanceOf(CalendarWriteError);

    expect(calendar.attempts).toBe(3); // CALENDAR_MAX_ATTEMPTS
    // No patient confirmation; reception was notified instead.
    expect(messaging.sent.filter((m) => m.to === PATIENT.phone)).toHaveLength(0);
    expect(messaging.sent.filter((m) => m.to === RECEPTION)).toHaveLength(1);

    const booking = await getById(pool, hold.id);
    expect(booking?.status).toBe("expired"); // hold released
    expect(booking?.googleEventId).toBeNull();
    expect(await countAudit(pool, "booking_confirmed")).toBe(0);
    expect(await countAudit(pool, "hold_released")).toBe(1);
    expect(await countAudit(pool, "escalated")).toBe(1);
  });
});

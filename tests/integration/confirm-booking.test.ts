import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeCalendar } from "../../src/adapters/fakes/fake-calendar";
import { FakeClock } from "../../src/adapters/fakes/fake-clock";
import { FakeMessaging } from "../../src/adapters/fakes/fake-messaging";
import { HOLD_TTL_MS } from "../../src/config";
import type { Pool } from "../../src/db/pool";
import { getById } from "../../src/db/repositories/booking-repo";
import type { Deps } from "../../src/deps";
import { CalendarWriteError, HoldExpiredError } from "../../src/domain/errors";
import { dispatchOutbox } from "../../src/jobs/dispatch-outbox";
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

interface OutboxRow {
  id: string;
  kind: string;
  to_phone: string;
  body: string;
  dedupe_key: string | null;
  status: string;
}
async function outboxRows(kind?: string): Promise<OutboxRow[]> {
  const r = kind
    ? await pool.query("SELECT * FROM outbox_message WHERE kind = $1 ORDER BY created_at", [kind])
    : await pool.query("SELECT * FROM outbox_message ORDER BY created_at");
  return r.rows as OutboxRow[];
}

describe("confirm_booking", () => {
  it("writes exactly one event, enqueues ONE pt-BR confirmation in the commit transaction, stamps created_via/consent_at (T242)", async () => {
    const clock = new FakeClock(NOW);
    const calendar = new FakeCalendar();
    const messaging = new FakeMessaging();
    const d = makeDeps(clock, calendar, messaging);

    const hold = await holdSlot(d, { start: SLOT, type: "cleaning" }, PATIENT);
    const { booking, outcome } = await confirmBooking(d, hold.id, PATIENT);

    expect(outcome).toBe("confirmed");
    expect(calendar.createdCount).toBe(1);
    expect(booking.status).toBe("confirmed");
    expect(booking.googleEventId).toBeTruthy();
    expect(booking.consentAt).not.toBeNull();
    expect(booking.createdVia).toBe("ai");

    // No direct send: the confirmation lives in the outbox, committed with the booking.
    expect(messaging.sent).toHaveLength(0);
    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("booking_confirmation");
    expect(rows[0].to_phone).toBe(PATIENT.phone);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].dedupe_key).toBe(`booking_confirmation:${booking.id}`);
    expect(rows[0].body).toContain("confirmada");
    expect(rows[0].body).toContain("limpeza"); // pt-BR type label

    // The audited domain write references the outbox row (traceability, SC-206).
    const audit = await pool.query(
      "SELECT payload FROM audit_log WHERE action = 'booking_confirmed'",
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].payload.outboxId).toBe(rows[0].id);

    // Dispatching delivers exactly one patient message.
    await dispatchOutbox(d);
    expect(messaging.sent).toEqual([{ to: PATIENT.phone, body: rows[0].body }]);
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
    expect(await outboxRows()).toHaveLength(0);
    expect(await countAudit(pool, "booking_confirmed")).toBe(0);
  });

  it("is idempotent: repeating confirm does not duplicate the event, the outbox row or the message", async () => {
    const clock = new FakeClock(NOW);
    const calendar = new FakeCalendar();
    const messaging = new FakeMessaging();
    const d = makeDeps(clock, calendar, messaging);

    const hold = await holdSlot(d, { start: SLOT, type: "cleaning" }, PATIENT);
    const first = await confirmBooking(d, hold.id, PATIENT);
    const second = await confirmBooking(d, hold.id, PATIENT);

    expect(first.outcome).toBe("confirmed");
    expect(second.outcome).toBe("already_confirmed");
    expect(second.booking.id).toBe(first.booking.id);
    expect(calendar.createdCount).toBe(1);
    expect(await outboxRows()).toHaveLength(1);
    await dispatchOutbox(d);
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
    await dispatchOutbox(d);
    // No patient confirmation (neither direct nor queued); reception was notified instead.
    expect(messaging.sent.filter((m) => m.to === PATIENT.phone)).toHaveLength(0);
    expect(await outboxRows("booking_confirmation")).toHaveLength(0);
    expect(messaging.sent.filter((m) => m.to === RECEPTION)).toHaveLength(1);

    const booking = await getById(pool, hold.id);
    expect(booking?.status).toBe("expired"); // hold released
    expect(booking?.googleEventId).toBeNull();
    expect(await countAudit(pool, "booking_confirmed")).toBe(0);
    expect(await countAudit(pool, "hold_released")).toBe(1);
    expect(await countAudit(pool, "escalated")).toBe(1);
  });

  it("retries a TRANSIENT calendar failure and succeeds without escalating", async () => {
    const clock = new FakeClock(NOW);
    const calendar = new FakeCalendar();
    calendar.failTimes = 1; // fail once, then succeed on retry
    const messaging = new FakeMessaging();
    const d = makeDeps(clock, calendar, messaging);

    const hold = await holdSlot(d, { start: SLOT, type: "cleaning" }, PATIENT);
    const { booking, outcome } = await confirmBooking(d, hold.id, PATIENT);

    expect(outcome).toBe("confirmed");
    expect(calendar.attempts).toBe(2); // 1 failure + 1 success
    expect(calendar.createdCount).toBe(1);
    expect(booking.status).toBe("confirmed");
    expect(booking.googleEventId).toBeTruthy();
    await dispatchOutbox(d);
    expect(messaging.sent.filter((m) => m.to === PATIENT.phone)).toHaveLength(1);
    expect(messaging.sent.filter((m) => m.to === RECEPTION)).toHaveLength(0);
    expect(await countAudit(pool, "booking_confirmed")).toBe(1);
    expect(await countAudit(pool, "hold_released")).toBe(0);
    expect(await countAudit(pool, "escalated")).toBe(0);
  });

  it("two REAL concurrent confirms on the same hold are idempotent (one event, one outbox row, one message)", async () => {
    const clock = new FakeClock(NOW);
    const calendar = new FakeCalendar();
    const messaging = new FakeMessaging();
    const d = makeDeps(clock, calendar, messaging);

    const hold = await holdSlot(d, { start: SLOT, type: "cleaning" }, PATIENT);
    const [a, b] = await Promise.all([
      confirmBooking(d, hold.id, PATIENT),
      confirmBooking(d, hold.id, PATIENT),
    ]);

    expect(a.booking.id).toBe(hold.id);
    expect(b.booking.id).toBe(hold.id);
    expect(calendar.createdCount).toBe(1); // single event despite two callers
    expect(calendar.deleted).toHaveLength(0); // no orphan compensation
    expect(await outboxRows("booking_confirmation")).toHaveLength(1); // dedupe_key
    await dispatchOutbox(d);
    expect(messaging.sent.filter((m) => m.to === PATIENT.phone)).toHaveLength(1);
    expect(messaging.sent.filter((m) => m.to === RECEPTION)).toHaveLength(0);
    expect(await countAudit(pool, "booking_confirmed")).toBe(1);
    expect(await countAudit(pool, "calendar_orphan_compensated")).toBe(0);
  });
});

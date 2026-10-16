import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeCalendar } from "../../src/adapters/fakes/fake-calendar";
import { FakeClock } from "../../src/adapters/fakes/fake-clock";
import { FakeMessaging } from "../../src/adapters/fakes/fake-messaging";
import type { Pool } from "../../src/db/pool";
import { getById } from "../../src/db/repositories/booking-repo";
import type { Deps } from "../../src/deps";
import { HoldExpiredError } from "../../src/domain/errors";
import { dispatchOutbox } from "../../src/jobs/dispatch-outbox";
import type { CalendarPort } from "../../src/ports/calendar-port";
import { confirmBooking } from "../../src/tools/confirm-booking";
import { holdSlot } from "../../src/tools/hold-slot";
import { countAudit, ensureSchema, resetDb, seedRule, testPool } from "../helpers/db";
import { interceptingPool } from "../helpers/pool";

const NOW = new Date("2026-06-15T12:00:00Z");
const SLOT = new Date("2026-06-15T14:00:00Z");
const RECEPTION = "+5511999999999";
const PATIENT = { phone: "+55a", name: "Maria" };

// A calendar whose createEvent succeeds (so an event IS written), but is harmless
// for placing the hold first.
const inertCalendar: CalendarPort = {
  async createEvent() {
    return { eventId: "x" };
  },
  async deleteEvent() {},
};

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

function depsWith(calendar: CalendarPort, messaging: FakeMessaging): Deps {
  return { pool, clock: new FakeClock(NOW), calendar, messaging, receptionPhone: RECEPTION };
}

/** The confirmation UPDATE (…SET status='confirmed') fails → `commit_failed` orphan branch. */
function poolFailingConfirmTx(real: Pool, sentinel: Error): Pool {
  return interceptingPool(real, {
    reject: (sql) => (sql.includes("status = 'confirmed'") ? sentinel : null),
  });
}

/** The FIRST `COMMIT` issued through the wrapper fails (the confirmation transaction). */
function poolFailingFirstCommit(real: Pool, sentinel: Error): Pool {
  let failed = false;
  return interceptingPool(real, {
    reject: (sql) => {
      if (!failed && sql.trim().toUpperCase() === "COMMIT") {
        failed = true;
        return sentinel;
      }
      return null;
    },
  });
}

describe("confirm_booking — orphan-event compensation", () => {
  it("deletes the event, escalates, and throws when the hold vanishes after the event is written", async () => {
    const messaging = new FakeMessaging();
    const hold = await holdSlot(
      depsWith(inertCalendar, messaging),
      { start: SLOT, type: "cleaning" },
      PATIENT,
    );

    const deleted: string[] = [];
    // Race: while writing the event, the hold gets swept/expired in the DB.
    const racingCalendar: CalendarPort = {
      async createEvent(input) {
        await pool.query(
          "UPDATE booking SET status='expired', expires_at=NULL WHERE id=$1 AND status='held'",
          [input.idempotencyKey],
        );
        return { eventId: "evt_orphan" };
      },
      async deleteEvent(key) {
        deleted.push(key);
      },
    };

    await expect(
      confirmBooking(depsWith(racingCalendar, messaging), hold.id, PATIENT),
    ).rejects.toBeInstanceOf(HoldExpiredError);

    expect(deleted).toContain(hold.id); // orphan event compensated
    await dispatchOutbox(depsWith(racingCalendar, messaging));
    expect(messaging.sent.filter((m) => m.to === RECEPTION)).toHaveLength(1); // escalated
    expect(messaging.sent.filter((m) => m.to === PATIENT.phone)).toHaveLength(0); // no patient confirmation
    expect(await countOutbox("booking_confirmation")).toBe(0);

    const booking = await getById(pool, hold.id);
    expect(booking?.status).toBe("expired");
    expect(booking?.googleEventId).toBeNull();
    expect(await countAudit(pool, "calendar_orphan_compensated")).toBe(1);
    expect(await countAudit(pool, "booking_confirmed")).toBe(0);
  });

  it("returns idempotently and keeps the event when a concurrent confirm already won", async () => {
    const messaging = new FakeMessaging();
    const hold = await holdSlot(
      depsWith(inertCalendar, messaging),
      { start: SLOT, type: "cleaning" },
      PATIENT,
    );

    const deleted: string[] = [];
    const WINNER_EVENT = "evt_winner";
    // Race: another confirm wins (marks the booking confirmed with the same event id).
    const racingCalendar: CalendarPort = {
      async createEvent(input) {
        await pool.query(
          "UPDATE booking SET status='confirmed', google_event_id=$2, consent_at=now(), expires_at=NULL WHERE id=$1 AND status='held'",
          [input.idempotencyKey, WINNER_EVENT],
        );
        return { eventId: WINNER_EVENT };
      },
      async deleteEvent(key) {
        deleted.push(key);
      },
    };

    const result = await confirmBooking(depsWith(racingCalendar, messaging), hold.id, PATIENT);

    expect(result.outcome).toBe("already_confirmed");
    expect(result.booking.status).toBe("confirmed");
    expect(result.booking.googleEventId).toBe(WINNER_EVENT);
    expect(deleted).toHaveLength(0); // must NOT delete the winner's event
    expect(await countOutbox("booking_confirmation")).toBe(0); // winner owns the confirmation
    expect(messaging.sent.filter((m) => m.to === PATIENT.phone)).toHaveLength(0);
  });

  it("compensates with reason 'commit_failed' when the confirmation transaction throws", async () => {
    const messaging = new FakeMessaging();
    const hold = await holdSlot(
      depsWith(inertCalendar, messaging),
      { start: SLOT, type: "cleaning" },
      PATIENT,
    );

    const deleted: string[] = [];
    const calendar: CalendarPort = {
      async createEvent() {
        return { eventId: "evt_commit_fail" };
      },
      async deleteEvent(key) {
        deleted.push(key);
      },
    };
    const sentinel = new Error("commit boom");
    const deps: Deps = {
      pool: poolFailingConfirmTx(pool, sentinel),
      clock: new FakeClock(NOW),
      calendar,
      messaging,
      receptionPhone: RECEPTION,
    };

    await expect(confirmBooking(deps, hold.id, PATIENT)).rejects.toBe(sentinel);

    expect(deleted).toContain(hold.id); // orphan event compensated
    await dispatchOutbox({ ...deps, pool });
    expect(messaging.sent.filter((m) => m.to === RECEPTION)).toHaveLength(1); // escalated
    expect(messaging.sent.filter((m) => m.to === PATIENT.phone)).toHaveLength(0); // no patient confirmation
    expect(await countOutbox("booking_confirmation")).toBe(0);

    const booking = await getById(pool, hold.id);
    expect(booking?.googleEventId).toBeNull();

    const audit = await pool.query(
      "SELECT payload FROM audit_log WHERE action = 'calendar_orphan_compensated'",
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].payload.reason).toBe("commit_failed");
    expect(await countAudit(pool, "booking_confirmed")).toBe(0);
  });

  it("a COMMIT that LANDED but whose acknowledgment was lost keeps the event, returns the booking and lets the outbox own the reply", async () => {
    const messaging = new FakeMessaging();
    const hold = await holdSlot(
      depsWith(inertCalendar, messaging),
      { start: SLOT, type: "cleaning" },
      PATIENT,
    );
    const deleted: string[] = [];
    const calendar: CalendarPort = {
      async createEvent() {
        return { eventId: "evt_ack_lost" };
      },
      async deleteEvent(key) {
        deleted.push(key);
      },
    };
    let lost = false;
    const deps: Deps = {
      pool: interceptingPool(pool, {
        after: (sql) => {
          if (!lost && sql.trim().toUpperCase() === "COMMIT") {
            lost = true;
            throw new Error("connection reset after COMMIT"); // the DB committed, we never heard back
          }
        },
      }),
      clock: new FakeClock(NOW),
      calendar,
      messaging,
      receptionPhone: RECEPTION,
    };

    const result = await confirmBooking(deps, hold.id, PATIENT);

    expect(lost).toBe(true);
    expect(result.outcome).toBe("confirmed"); // the outbox row exists → it owns the patient message
    expect(result.booking.status).toBe("confirmed");
    expect(result.booking.googleEventId).toBe("evt_ack_lost");
    expect(deleted).toHaveLength(0); // the committed event is NOT compensated away
    expect(await countOutbox("booking_confirmation")).toBe(1);
    expect(await countAudit(pool, "booking_confirmed")).toBe(1);
    expect(await countAudit(pool, "calendar_orphan_compensated")).toBe(0);
    expect(await countAudit(pool, "escalated")).toBe(0);
    await dispatchOutbox({ ...deps, pool });
    expect(messaging.sent.filter((m) => m.to === PATIENT.phone)).toHaveLength(1);
  });

  it("a COMMIT that fails AFTER the confirm UPDATE never yields a confirmed result nor a patient message [T232]", async () => {
    const messaging = new FakeMessaging();
    const hold = await holdSlot(
      depsWith(inertCalendar, messaging),
      { start: SLOT, type: "cleaning" },
      PATIENT,
    );

    const deleted: string[] = [];
    const calendar: CalendarPort = {
      async createEvent() {
        return { eventId: "evt_commit_boom" };
      },
      async deleteEvent(key) {
        deleted.push(key);
      },
    };
    const sentinel = new Error("COMMIT boom");
    const deps: Deps = {
      pool: poolFailingFirstCommit(pool, sentinel),
      clock: new FakeClock(NOW),
      calendar,
      messaging,
      receptionPhone: RECEPTION,
    };

    await expect(confirmBooking(deps, hold.id, PATIENT)).rejects.toBe(sentinel);

    // Rolled back: no event id, no confirmation enqueued, nothing sent to the patient — and the hold
    // was ended before its event was deleted, so it can never be confirmed with it (008 review).
    const booking = await getById(pool, hold.id);
    expect(booking?.status).toBe("expired");
    expect(booking?.googleEventId).toBeNull();
    expect(await countOutbox("booking_confirmation")).toBe(0);
    expect(await countAudit(pool, "booking_confirmed")).toBe(0);
    expect(messaging.sent.filter((m) => m.to === PATIENT.phone)).toHaveLength(0);

    // Compensated + escalated with the right reason.
    expect(deleted).toContain(hold.id);
    const audit = await pool.query(
      "SELECT payload FROM audit_log WHERE action = 'calendar_orphan_compensated'",
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].payload.reason).toBe("commit_failed");
    await dispatchOutbox({ ...deps, pool });
    expect(messaging.sent.filter((m) => m.to === RECEPTION)).toHaveLength(1);
  });
});

async function countOutbox(kind: string): Promise<number> {
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM outbox_message WHERE kind = $1",
    [kind],
  );
  return rows[0].n;
}

describe("confirm_booking — 006 review findings", () => {
  it("an orphan event that cannot be removed is not reported as compensated: reception removes it", async () => {
    const calendar = new FakeCalendar();
    calendar.deleteFailAlways = true;
    const d = depsWith(calendar, new FakeMessaging());
    const hold = await holdSlot(d, { start: SLOT, type: "cleaning" }, PATIENT);
    const failing = poolFailingConfirmTx(pool, new Error("confirm tx down"));
    await confirmBooking({ ...d, pool: failing }, hold.id, PATIENT).catch(() => {});
    const orphan = await pool.query(
      "SELECT payload FROM audit_log WHERE action = 'calendar_orphan_compensated'",
    );
    expect(orphan.rows[0].payload).toMatchObject({ deleted: false });
    expect(await countAudit(pool, "calendar_delete_failed")).toBe(1);
    const notice = await pool.query(
      "SELECT dedupe_key FROM outbox_message WHERE kind = 'reception_notice'",
    );
    expect(notice.rows.map((r) => r.dedupe_key)).toEqual([`calendar_cleanup:${hold.id}`]);
  });

  it("a hold whose TTL ran out during the calendar call is not confirmed, even before any sweep", async () => {
    const clock = new FakeClock(NOW);
    const calendar = new FakeCalendar();
    const d: Deps = {
      pool,
      clock,
      calendar,
      messaging: new FakeMessaging(),
      receptionPhone: RECEPTION,
    };
    const hold = await holdSlot(d, { start: SLOT, type: "cleaning" }, PATIENT);
    const slowCalendar: CalendarPort = {
      async createEvent(input) {
        clock.advance(11 * 60_000); // the TTL is 10 minutes
        return calendar.createEvent(input);
      },
      deleteEvent: (key) => calendar.deleteEvent(key),
    };
    const err = await confirmBooking({ ...d, calendar: slowCalendar }, hold.id, PATIENT).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((await getById(pool, hold.id))?.status).not.toBe("confirmed");
    expect(calendar.events.has(hold.id)).toBe(false); // compensated
  });
});

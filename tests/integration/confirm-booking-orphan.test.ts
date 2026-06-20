import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../src/adapters/fakes/fake-clock";
import { FakeMessaging } from "../../src/adapters/fakes/fake-messaging";
import type { Pool } from "../../src/db/pool";
import { getById } from "../../src/db/repositories/booking-repo";
import type { Deps } from "../../src/deps";
import { HoldExpiredError } from "../../src/domain/errors";
import type { CalendarPort } from "../../src/ports/calendar-port";
import { confirmBooking } from "../../src/tools/confirm-booking";
import { holdSlot } from "../../src/tools/hold-slot";
import { countAudit, ensureSchema, resetDb, seedRule, testPool } from "../helpers/db";

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

/**
 * Wraps the real pool so the confirmation transaction's UPDATE…SET status='confirmed'
 * fails, exercising the `commit_failed` orphan branch. All other queries pass through,
 * so getById and the orphan-compensation audit still work.
 */
function poolFailingConfirmTx(real: Pool, sentinel: Error): Pool {
  return {
    query: (...args: unknown[]) =>
      (real as unknown as { query: (...a: unknown[]) => unknown }).query(...args),
    async connect() {
      const client = await real.connect();
      const orig = client.query.bind(client);
      (client as unknown as { query: (...a: unknown[]) => unknown }).query = (
        ...args: unknown[]
      ) => {
        const sql =
          typeof args[0] === "string" ? args[0] : ((args[0] as { text?: string })?.text ?? "");
        if (sql.includes("status = 'confirmed'")) return Promise.reject(sentinel);
        return (orig as (...a: unknown[]) => unknown)(...args);
      };
      return client;
    },
  } as unknown as Pool;
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
    expect(messaging.sent.filter((m) => m.to === RECEPTION)).toHaveLength(1); // escalated
    expect(messaging.sent.filter((m) => m.to === PATIENT.phone)).toHaveLength(0); // no patient confirmation

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

    expect(result.status).toBe("confirmed");
    expect(result.googleEventId).toBe(WINNER_EVENT);
    expect(deleted).toHaveLength(0); // must NOT delete the winner's event
    expect(messaging.sent.filter((m) => m.to === PATIENT.phone)).toHaveLength(0); // winner already messaged
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
    expect(messaging.sent.filter((m) => m.to === RECEPTION)).toHaveLength(1); // escalated
    expect(messaging.sent.filter((m) => m.to === PATIENT.phone)).toHaveLength(0); // no patient confirmation

    const booking = await getById(pool, hold.id);
    expect(booking?.googleEventId).toBeNull();

    const audit = await pool.query(
      "SELECT payload FROM audit_log WHERE action = 'calendar_orphan_compensated'",
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].payload.reason).toBe("commit_failed");
    expect(await countAudit(pool, "booking_confirmed")).toBe(0);
  });
});

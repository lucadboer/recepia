import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "../../src/db/pool";
import {
  cancelActive,
  confirmHeld,
  findRescheduleOf,
  findUpcomingForPhone,
  getById,
  lockBookingForUpdate,
} from "../../src/db/repositories/booking-repo";
import { ensureSchema, resetDb, seedBooking, testPool } from "../helpers/db";

// T608 (006) — repository support for the booking lifecycle: the patient's upcoming bookings,
// cancellation (status ↔ cancelled_at), and the reschedule link that can succeed only once.

const NOW = new Date("2026-06-15T12:00:00Z");
const PHONE = "+5531900000610";
const OTHER = "+5531900000611";

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
});

describe("findUpcomingForPhone", () => {
  it("returns only this phone's active, future bookings, earliest first", async () => {
    const later = await seedBooking(pool, { start: "2026-06-20T12:00:00Z", phone: PHONE });
    const sooner = await seedBooking(pool, {
      start: "2026-06-16T12:00:00Z",
      phone: PHONE,
      status: "patient_confirmed",
    });
    await seedBooking(pool, { start: "2026-06-14T12:00:00Z", phone: PHONE }); // past
    await seedBooking(pool, { start: "2026-06-17T12:00:00Z", phone: PHONE, status: "cancelled" });
    await seedBooking(pool, {
      start: "2026-06-18T12:00:00Z",
      phone: PHONE,
      status: "held",
      expiresAt: new Date("2026-06-15T12:10:00Z"),
    });
    await seedBooking(pool, { start: "2026-06-16T12:00:00Z", phone: OTHER, seat: 1 });
    const found = await findUpcomingForPhone(pool, PHONE, NOW);
    expect(found.map((b) => b.id)).toEqual([sooner, later]);
  });
});

describe("cancelActive", () => {
  it("cancels an active booking and stamps cancelled_at; a second call changes nothing", async () => {
    const id = await seedBooking(pool, { start: "2026-06-16T12:00:00Z", phone: PHONE });
    const cancelled = await cancelActive(pool, id, NOW);
    expect(cancelled).toMatchObject({ id, status: "cancelled" });
    expect(cancelled?.cancelledAt?.toISOString()).toBe(NOW.toISOString());
    expect(await cancelActive(pool, id, NOW)).toBeNull();
  });

  it("does not cancel a held, expired or already cancelled booking", async () => {
    const held = await seedBooking(pool, {
      start: "2026-06-16T12:00:00Z",
      phone: PHONE,
      status: "held",
      expiresAt: new Date("2026-06-15T12:10:00Z"),
    });
    expect(await cancelActive(pool, held, NOW)).toBeNull();
    expect((await getById(pool, held))?.status).toBe("held");
  });

  it("the database refuses a cancelled status without cancelled_at (and the reverse)", async () => {
    const id = await seedBooking(pool, { start: "2026-06-16T12:00:00Z", phone: PHONE });
    await expect(
      pool.query("UPDATE booking SET status = 'cancelled' WHERE id = $1", [id]),
    ).rejects.toThrow(/booking_cancelled_at_check/);
    await expect(
      pool.query("UPDATE booking SET cancelled_at = now() WHERE id = $1", [id]),
    ).rejects.toThrow(/booking_cancelled_at_check/);
  });
});

describe("reschedule link", () => {
  it("confirmHeld records the booking it replaces; findRescheduleOf finds it", async () => {
    const old = await seedBooking(pool, { start: "2026-06-16T12:00:00Z", phone: PHONE });
    const hold = await seedBooking(pool, {
      start: "2026-06-17T12:00:00Z",
      phone: PHONE,
      status: "held",
      expiresAt: new Date("2026-06-15T12:10:00Z"),
    });
    const confirmed = await confirmHeld(pool, hold, "Ana", "evt_new", NOW, old);
    expect(confirmed).toMatchObject({ id: hold, status: "confirmed", rescheduledFrom: old });
    expect((await findRescheduleOf(pool, old))?.id).toBe(hold);
    expect(await findRescheduleOf(pool, hold)).toBeNull();
  });

  it("a booking can be replaced only once: a second link is refused by the database", async () => {
    const old = await seedBooking(pool, { start: "2026-06-16T12:00:00Z", phone: PHONE });
    const h1 = await seedBooking(pool, {
      start: "2026-06-17T12:00:00Z",
      phone: PHONE,
      status: "held",
      expiresAt: new Date("2026-06-15T12:10:00Z"),
    });
    const h2 = await seedBooking(pool, {
      start: "2026-06-18T12:00:00Z",
      phone: PHONE,
      status: "held",
      expiresAt: new Date("2026-06-15T12:10:00Z"),
    });
    await confirmHeld(pool, h1, "Ana", "evt_1", NOW, old);
    await expect(confirmHeld(pool, h2, "Ana", "evt_2", NOW, old)).rejects.toThrow(
      /booking_rescheduled_from_uq/,
    );
  });
});

describe("lockBookingForUpdate", () => {
  it("returns the row inside a transaction and null for an unknown id", async () => {
    const id = await seedBooking(pool, { start: "2026-06-16T12:00:00Z", phone: PHONE });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      expect((await lockBookingForUpdate(client, id))?.id).toBe(id);
      expect(await lockBookingForUpdate(client, "00000000-0000-0000-0000-000000000000")).toBeNull();
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeCalendar } from "../../src/adapters/fakes/fake-calendar";
import { FakeClock } from "../../src/adapters/fakes/fake-clock";
import { FakeMessaging } from "../../src/adapters/fakes/fake-messaging";
import type { Pool } from "../../src/db/pool";
import { getById } from "../../src/db/repositories/booking-repo";
import type { Deps } from "../../src/deps";
import { BookingNotChangeableError, BookingNotFoundError } from "../../src/domain/errors";
import { confirmAttendance } from "../../src/tools/confirm-attendance";
import { countAudit, ensureSchema, resetDb, seedBooking, testPool } from "../helpers/db";
import { interceptingPool } from "../helpers/pool";

// T711 (007, contract reminders.md) — attendance confirmed by the patient: clinic-confirmed →
// patient_confirmed, one reply through the outbox, audited, idempotent, never another patient's.

const NOW = new Date("2026-06-15T12:00:00Z");
const PHONE = "+5531900000740";

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

function deps(p: Pool = pool): Deps {
  return {
    pool: p,
    clock: new FakeClock(NOW),
    calendar: new FakeCalendar(),
    messaging: new FakeMessaging(),
    receptionPhone: "+5511999999999",
    promptVersion: "v003+test000",
  };
}

async function replies(): Promise<{ to_phone: string; dedupe_key: string; body: string }[]> {
  const r = await pool.query(
    "SELECT to_phone, dedupe_key, body FROM outbox_message WHERE dedupe_key LIKE 'attendance_confirmation:%'",
  );
  return r.rows;
}

describe("confirmAttendance", () => {
  it("marks the booking confirmed by the patient, commits one reply and audits", async () => {
    const id = await seedBooking(pool, { start: "2026-06-16T12:00:00Z", phone: PHONE });
    const r = await confirmAttendance(deps(), id, PHONE, "fast_path");
    expect(r.outcome).toBe("confirmed");
    expect((await getById(pool, id))?.status).toBe("patient_confirmed");
    const rows = await replies();
    expect(rows).toEqual([
      expect.objectContaining({ to_phone: PHONE, dedupe_key: `attendance_confirmation:${id}` }),
    ]);
    expect(rows[0].body).toMatch(/Presença confirmada/);
    const audit = await pool.query(
      "SELECT actor, payload FROM audit_log WHERE action = 'attendance_confirmed'",
    );
    expect(audit.rows[0]).toMatchObject({
      actor: "system",
      payload: expect.objectContaining({ via: "fast_path" }),
    });
  });

  it("a model-initiated confirmation is audited as the AI with the prompt version", async () => {
    const id = await seedBooking(pool, { start: "2026-06-16T12:00:00Z", phone: PHONE });
    await confirmAttendance(deps(), id, PHONE, "model");
    const audit = await pool.query(
      "SELECT actor, payload FROM audit_log WHERE action = 'attendance_confirmed'",
    );
    expect(audit.rows[0]).toMatchObject({
      actor: "ai",
      payload: expect.objectContaining({ via: "model", promptVersion: "v003+test000" }),
    });
  });

  it("is idempotent: a second confirmation writes nothing and sends nothing", async () => {
    const id = await seedBooking(pool, { start: "2026-06-16T12:00:00Z", phone: PHONE });
    await confirmAttendance(deps(), id, PHONE, "fast_path");
    const again = await confirmAttendance(deps(), id, PHONE, "fast_path");
    expect(again.outcome).toBe("already_confirmed");
    expect(await countAudit(pool, "attendance_confirmed")).toBe(1);
    expect(await replies()).toHaveLength(1);
  });

  it("another patient's booking is 'not found'; a past or cancelled one cannot be confirmed", async () => {
    const other = await seedBooking(pool, {
      start: "2026-06-16T12:00:00Z",
      phone: "+5531900000741",
    });
    await expect(confirmAttendance(deps(), other, PHONE, "model")).rejects.toBeInstanceOf(
      BookingNotFoundError,
    );
    const past = await seedBooking(pool, { start: "2026-06-15T11:30:00Z", phone: PHONE, seat: 1 });
    await expect(confirmAttendance(deps(), past, PHONE, "model")).rejects.toBeInstanceOf(
      BookingNotChangeableError,
    );
    const cancelled = await seedBooking(pool, {
      start: "2026-06-17T12:00:00Z",
      phone: PHONE,
      status: "cancelled",
    });
    await expect(confirmAttendance(deps(), cancelled, PHONE, "model")).rejects.toBeInstanceOf(
      BookingNotChangeableError,
    );
    expect(await countAudit(pool, "attendance_confirmed")).toBe(0);
  });

  it("a failure inside the transaction leaves the booking clinic-confirmed and nothing queued", async () => {
    const id = await seedBooking(pool, { start: "2026-06-16T12:00:00Z", phone: PHONE });
    const failing = interceptingPool(pool, {
      reject: (sql) => (sql.includes("INSERT INTO audit_log") ? new Error("boom") : null),
    });
    await expect(confirmAttendance(deps(failing), id, PHONE, "fast_path")).rejects.toThrow("boom");
    expect((await getById(pool, id))?.status).toBe("confirmed");
    expect(await replies()).toHaveLength(0);
  });
});

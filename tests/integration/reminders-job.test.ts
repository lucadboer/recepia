import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeCalendar } from "../../src/adapters/fakes/fake-calendar";
import { FakeClock } from "../../src/adapters/fakes/fake-clock";
import { FakeMessaging } from "../../src/adapters/fakes/fake-messaging";
import { recordConsent, recordOptOut } from "../../src/agent/consent";
import type { Pool } from "../../src/db/pool";
import type { Deps } from "../../src/deps";
import { dispatchOutbox } from "../../src/jobs/dispatch-outbox";
import {
  enqueueDueReminders,
  notifyUnconfirmed,
  type ReminderSettings,
} from "../../src/jobs/reminders";
import { cancelBooking } from "../../src/tools/cancel-booking";
import { countAudit, ensureSchema, resetDb, seedBooking, testPool } from "../helpers/db";

// T709 / T718 (007, contract reminders.md) — one reminder per qualifying appointment, ~24 h
// before, only with a current opt-in; one reception notice when the patient did not answer.

const NOW = new Date("2026-06-15T12:00:00Z"); // Mon 09:00 local
const HOUR = 60 * 60 * 1000;
const PHONE = "+5531900000710";
const SETTINGS: ReminderSettings = { leadMs: 24 * HOUR, noticeLeadMs: 3 * HOUR, template: null };

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

function deps(clock = new FakeClock(NOW), messaging = new FakeMessaging()): Deps {
  return { pool, clock, calendar: new FakeCalendar(), messaging, receptionPhone: "+5511999999999" };
}

/** A confirmed booking `inH` hours from NOW, created `createdHAgo` hours before NOW. */
async function booking(
  inH: number,
  opts: {
    phone?: string;
    createdHAgo?: number;
    status?: "confirmed" | "patient_confirmed" | "cancelled";
  } = {},
): Promise<string> {
  const start = new Date(NOW.getTime() + inH * HOUR);
  const id = await seedBooking(pool, {
    start: start.toISOString(),
    phone: opts.phone ?? PHONE,
    status: opts.status ?? "confirmed",
    name: "Ana Teste",
  });
  const created = new Date(NOW.getTime() - (opts.createdHAgo ?? 72) * HOUR);
  await pool.query("UPDATE booking SET created_at = $2 WHERE id = $1", [id, created]);
  return id;
}

async function reminders(): Promise<
  { to_phone: string; dedupe_key: string; status: string; template: unknown; body: string }[]
> {
  const r = await pool.query(
    "SELECT to_phone, dedupe_key, status, template, body FROM outbox_message WHERE kind = 'appointment_reminder' ORDER BY created_at",
  );
  return r.rows;
}

describe("enqueueDueReminders — who gets a reminder", () => {
  it("queues exactly one reminder for a qualifying appointment, stamped and audited", async () => {
    const d = deps();
    await recordConsent(d, PHONE);
    const id = await booking(20);
    const r = await enqueueDueReminders(d, SETTINGS);
    expect(r.queued).toBe(1);
    const rows = await reminders();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      to_phone: PHONE,
      dedupe_key: `appointment_reminder:${id}`,
      template: null,
    });
    expect(rows[0].body).toContain("16/06/2026 às 05:00");
    const b = await pool.query("SELECT reminder_sent_at FROM booking WHERE id = $1", [id]);
    expect(b.rows[0].reminder_sent_at?.toISOString()).toBe(NOW.toISOString());
    expect(await countAudit(pool, "reminder_enqueued")).toBe(1);
  });

  it("timing table: inside (3h, 24h] only, booked at least 24h before its start", async () => {
    const d = deps();
    await recordConsent(d, PHONE);
    const inside = await booking(10);
    await booking(30); // more than 24 h away: later
    await booking(2); // inside the notice lead: too late for a reminder
    await booking(12, { createdHAgo: 1 }); // booked 13 h before its start: no reminder
    await booking(18, { status: "patient_confirmed" }); // already confirmed by the patient
    await booking(16, { status: "cancelled" });
    await enqueueDueReminders(d, SETTINGS);
    expect((await reminders()).map((r) => r.dedupe_key)).toEqual([
      `appointment_reminder:${inside}`,
    ]);
  });

  it("never reminds a patient whose latest consent is an opt-out or who never consented", async () => {
    const d = deps();
    const optedOut = "+5531900000711";
    await recordConsent(d, optedOut);
    await recordOptOut(d, optedOut);
    await booking(10, { phone: optedOut });
    await booking(11, { phone: "+5531900000712" }); // no consent row at all
    await enqueueDueReminders(d, SETTINGS);
    expect(await reminders()).toHaveLength(0);
  });

  it("is idempotent across runs and safe when two runs race", async () => {
    const d = deps();
    await recordConsent(d, PHONE);
    for (let i = 0; i < 5; i++) await booking(5 + i * 3, { phone: `+553190000072${i}` });
    for (let i = 0; i < 5; i++) await recordConsent(d, `+553190000072${i}`);
    const [a, b] = await Promise.all([
      enqueueDueReminders(d, SETTINGS),
      enqueueDueReminders(d, SETTINGS),
    ]);
    expect(a.queued + b.queued).toBe(5);
    await enqueueDueReminders(d, SETTINGS);
    expect(await reminders()).toHaveLength(5);
    expect(await countAudit(pool, "reminder_enqueued")).toBe(5);
  });

  it("attaches the configured template with its parameters (official channel)", async () => {
    const d = deps();
    await recordConsent(d, PHONE);
    await booking(20);
    await enqueueDueReminders(d, {
      ...SETTINGS,
      template: { name: "lembrete_consulta", language: "pt_BR" },
    });
    expect((await reminders())[0].template).toEqual({
      name: "lembrete_consulta",
      language: "pt_BR",
      params: ["Ana", "limpeza", "16/06/2026 às 05:00"],
    });
  });
});

describe("a queued reminder that must not go out", () => {
  it("an opt-out before delivery cancels it", async () => {
    const messaging = new FakeMessaging();
    const d = deps(new FakeClock(NOW), messaging);
    await recordConsent(d, PHONE);
    await booking(20);
    await enqueueDueReminders(d, SETTINGS);
    await recordOptOut(d, PHONE);
    await dispatchOutbox(d);
    expect(messaging.sent).toHaveLength(0);
    expect((await reminders())[0].status).toBe("cancelled");
  });

  it("a cancelled appointment's queued reminder is cancelled with it", async () => {
    const messaging = new FakeMessaging();
    const d = deps(new FakeClock(NOW), messaging);
    await recordConsent(d, PHONE);
    const id = await booking(20);
    await enqueueDueReminders(d, SETTINGS);
    await cancelBooking(d, id, PHONE);
    expect((await reminders())[0].status).toBe("cancelled");
    await dispatchOutbox(d);
    expect(messaging.sent.map((m) => m.body).some((b) => b.includes("Lembrete"))).toBe(false);
  });

  it("delivers the template to the messaging port", async () => {
    const messaging = new FakeMessaging();
    const d = deps(new FakeClock(NOW), messaging);
    await recordConsent(d, PHONE);
    await booking(20);
    await enqueueDueReminders(d, { ...SETTINGS, template: { name: "t", language: "pt_BR" } });
    await dispatchOutbox(d);
    expect(messaging.sent).toHaveLength(1);
    expect(messaging.sent[0].template).toMatchObject({ name: "t", language: "pt_BR" });
  });
});

describe("notifyUnconfirmed — reception knows who did not answer", () => {
  it("one notice per reminded appointment still unconfirmed within the lead; never twice", async () => {
    const clock = new FakeClock(NOW);
    const d = deps(clock);
    await recordConsent(d, PHONE);
    const id = await booking(20);
    await enqueueDueReminders(d, SETTINGS);
    await dispatchOutbox(d); // delivered — only a delivered reminder can go unanswered
    expect((await notifyUnconfirmed(d, SETTINGS)).notified).toBe(0); // 20 h away
    clock.advance(17.5 * HOUR); // 2.5 h before the appointment
    expect((await notifyUnconfirmed(d, SETTINGS)).notified).toBe(1);
    expect((await notifyUnconfirmed(d, SETTINGS)).notified).toBe(0);
    const n = await pool.query(
      "SELECT to_phone, dedupe_key, body FROM outbox_message WHERE kind = 'reception_notice'",
    );
    expect(n.rows).toHaveLength(1);
    expect(n.rows[0]).toMatchObject({
      to_phone: "+5511999999999",
      dedupe_key: `unconfirmed:${id}`,
    });
    expect(n.rows[0].body).toMatch(/não confirmou/);
    expect(await countAudit(pool, "unconfirmed_notified")).toBe(1);
  });

  it("no notice when the patient confirmed, cancelled, was never reminded, or it already started", async () => {
    const clock = new FakeClock(NOW);
    const d = deps(clock);
    await recordConsent(d, PHONE);
    const confirmed = await booking(20);
    const cancelled = await booking(20.5, { phone: "+5531900000730" });
    await recordConsent(d, "+5531900000730");
    await booking(21, { createdHAgo: 1, phone: "+5531900000731" }); // never reminded (booked late)
    await recordConsent(d, "+5531900000731");
    await enqueueDueReminders(d, SETTINGS);
    await pool.query("UPDATE booking SET status = 'patient_confirmed' WHERE id = $1", [confirmed]);
    await cancelBooking(d, cancelled, "+5531900000730");
    clock.advance(18 * HOUR);
    expect((await notifyUnconfirmed(d, SETTINGS)).notified).toBe(0);
    clock.advance(10 * HOUR); // all started
    expect((await notifyUnconfirmed(d, SETTINGS)).notified).toBe(0);
  });
});

describe("a rescheduled appointment's queued reminder (007 T717)", () => {
  it("is superseded by the move; the new booking only gets a reminder if it qualifies", async () => {
    const { holdSlot } = await import("../../src/tools/hold-slot");
    const { rescheduleBooking } = await import("../../src/tools/reschedule-booking");
    const { seedRule } = await import("../helpers/db");
    await seedRule(pool, { weekday: 2, startTime: "09:00", endTime: "18:00", capacity: 2 });
    const d = deps();
    await recordConsent(d, PHONE);
    const oldId = await booking(20); // Tue 05:00 local, reminded below
    await enqueueDueReminders(d, SETTINGS);
    const hold = await holdSlot(
      d,
      { start: new Date("2026-06-16T17:00:00Z"), type: "cleaning" },
      { phone: PHONE },
    );
    await rescheduleBooking(d, oldId, hold.id, PHONE);
    const rows = await reminders();
    expect(rows.map((r) => [r.dedupe_key, r.status])).toEqual([
      [`appointment_reminder:${oldId}`, "cancelled"],
    ]);
    await enqueueDueReminders(d, SETTINGS); // the new booking was made < 24 h before its start
    expect(await reminders()).toHaveLength(1);
  });
});

describe("007 review findings", () => {
  it("a reminder that was never delivered produces no 'did not confirm' notice", async () => {
    const clock = new FakeClock(NOW);
    const messaging = new FakeMessaging();
    messaging.failAlways = true;
    const d = deps(clock, messaging);
    await recordConsent(d, PHONE);
    await booking(20);
    await enqueueDueReminders(d, SETTINGS);
    await dispatchOutbox(d); // fails → still pending, not delivered
    clock.advance(17.5 * HOUR);
    expect((await notifyUnconfirmed(d, SETTINGS)).notified).toBe(0);
  });

  it("an opt-out that slipped in after the reminder was queued still stops it at delivery", async () => {
    const messaging = new FakeMessaging();
    const d = deps(new FakeClock(NOW), messaging);
    await recordConsent(d, PHONE);
    await booking(20);
    await enqueueDueReminders(d, SETTINGS);
    // The race: the opt-out committed without seeing the reminder row (no cancel of queued rows).
    await pool.query(
      "INSERT INTO patient_consent (phone, state, source) VALUES ($1, 'opted_out', 'race')",
      [PHONE],
    );
    const r = await dispatchOutbox(d);
    expect(r.cancelled).toBe(1);
    expect(messaging.sent).toHaveLength(0);
    expect((await reminders())[0].status).toBe("cancelled");
  });

  it("a queued 'did not confirm' notice is superseded when the patient confirms before it goes out", async () => {
    const { confirmAttendance } = await import("../../src/tools/confirm-attendance");
    const clock = new FakeClock(NOW);
    const d = deps(clock);
    await recordConsent(d, PHONE);
    const id = await booking(20);
    await enqueueDueReminders(d, SETTINGS);
    await dispatchOutbox(d);
    clock.advance(17.5 * HOUR);
    await notifyUnconfirmed(d, SETTINGS);
    await confirmAttendance(d, id, PHONE, "fast_path");
    const n = await pool.query("SELECT status FROM outbox_message WHERE dedupe_key = $1", [
      `unconfirmed:${id}`,
    ]);
    expect(n.rows[0].status).toBe("cancelled");
  });
});

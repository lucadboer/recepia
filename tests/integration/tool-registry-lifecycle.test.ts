import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeCalendar } from "../../src/adapters/fakes/fake-calendar";
import { FakeClock } from "../../src/adapters/fakes/fake-clock";
import { FakeMessaging } from "../../src/adapters/fakes/fake-messaging";
import { emptyState, startTurn } from "../../src/agent/conversation";
import { dispatchTool, type ToolContext } from "../../src/agent/tool-registry";
import { TOOL_NAMES } from "../../src/agent/tool-schemas";
import type { ConversationState } from "../../src/agent/types";
import type { Pool } from "../../src/db/pool";
import { getById } from "../../src/db/repositories/booking-repo";
import type { Deps } from "../../src/deps";
import { confirmBooking } from "../../src/tools/confirm-booking";
import { holdSlot } from "../../src/tools/hold-slot";
import { countAudit, ensureSchema, resetDb, seedRule, testPool } from "../helpers/db";

// T613 / T618 / T621 (006) — the registry is where model input meets a write path. A cancel or a
// reschedule only acts on a booking the lookup showed in THIS conversation, never in the same turn
// it was shown, and zero or several bookings are handed to reception by code.

const NOW = new Date("2026-06-15T12:00:00Z");
const BOOKED = new Date("2026-06-17T12:00:00Z"); // Wed 09:00 local
const PHONE = "+5531900000640";
const OTHER = "+5531900000641";

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
    await seedRule(pool, { weekday, startTime: "09:00", endTime: "18:00", capacity: 2 });
  }
});

function deps(): Deps {
  return {
    pool,
    clock: new FakeClock(NOW),
    calendar: new FakeCalendar(),
    messaging: new FakeMessaging(),
    receptionPhone: "+5511999999999",
  };
}

function at(state: ConversationState, d = deps()): ToolContext {
  return { deps: d, phone: PHONE, state, now: NOW };
}

async function book(start = BOOKED, phone = PHONE): Promise<string> {
  const d = deps();
  const hold = await holdSlot(d, { start, type: "cleaning" }, { phone });
  return (await confirmBooking(d, hold.id, { phone, name: "Ana Teste" })).booking.id;
}

/** Turn 1: the patient asked; the model looked the booking up. */
async function surfaced(): Promise<{ state: ConversationState; bookingId: string }> {
  const bookingId = await book();
  const s1 = startTurn(emptyState(PHONE, NOW), NOW);
  const r = await dispatchTool(at(s1), TOOL_NAMES.findBooking, {});
  expect(r.isError).toBe(false);
  return { state: r.state, bookingId };
}

describe("find_my_booking", () => {
  it("shows the single upcoming booking in clinic-local time and remembers the turn", async () => {
    const bookingId = await book();
    const s1 = startTurn(emptyState(PHONE, NOW), NOW);
    const r = await dispatchTool(at(s1), TOOL_NAMES.findBooking, {});
    expect(r.isError).toBe(false);
    const body = JSON.parse(r.content);
    expect(body).toMatchObject({ bookingId, start: "2026-06-17T09:00:00-03:00", type: "cleaning" });
    expect(body.label).toMatch(/17\/06 às 09:00/);
    expect(r.state.surfacedBookings).toEqual([{ bookingId, turn: 1 }]);
  });

  it("no upcoming booking → reception, by code, and nothing else is written (US3)", async () => {
    await book(BOOKED, OTHER);
    const r = await dispatchTool(
      at(startTurn(emptyState(PHONE, NOW), NOW)),
      TOOL_NAMES.findBooking,
      {},
    );
    expect(r.escalated).toBe(true);
    expect(r.state.status).toBe("escalated");
    const esc = await pool.query("SELECT payload FROM audit_log WHERE action = 'escalated'");
    expect(esc.rows[0].payload).toMatchObject({ reason: "booking_not_found" });
  });

  it("two upcoming bookings → reception, by code, nothing cancelled (US3)", async () => {
    await book();
    await book(new Date("2026-06-17T13:00:00Z"));
    const r = await dispatchTool(
      at(startTurn(emptyState(PHONE, NOW), NOW)),
      TOOL_NAMES.findBooking,
      {},
    );
    expect(r.escalated).toBe(true);
    const esc = await pool.query("SELECT payload FROM audit_log WHERE action = 'escalated'");
    expect(esc.rows[0].payload).toMatchObject({ reason: "multiple_bookings" });
    expect(await countAudit(pool, "booking_cancelled")).toBe(0);
  });
});

describe("cancel_booking gates", () => {
  it("refuses a booking id never shown in this conversation (not_surfaced), even the patient's own", async () => {
    const bookingId = await book();
    const s = startTurn(emptyState(PHONE, NOW), NOW);
    const r = await dispatchTool(at(s), TOOL_NAMES.cancelBooking, { booking_id: bookingId });
    expect(r).toMatchObject({ isError: true, rejectedBy: "not_surfaced" });
    expect((await getById(pool, bookingId))?.status).toBe("confirmed");
  });

  it("refuses another patient's booking id (never shown here) with zero writes", async () => {
    const othersId = await book(BOOKED, OTHER);
    const { state } = await surfaced();
    const r = await dispatchTool(at(startTurn(state, NOW)), TOOL_NAMES.cancelBooking, {
      booking_id: othersId,
    });
    expect(r).toMatchObject({ isError: true, rejectedBy: "not_surfaced" });
    expect((await getById(pool, othersId))?.status).toBe("confirmed");
  });

  it("refuses to cancel in the same turn the booking was shown (confirmation_required)", async () => {
    const { state, bookingId } = await surfaced();
    const r = await dispatchTool(at(state), TOOL_NAMES.cancelBooking, { booking_id: bookingId });
    expect(r).toMatchObject({ isError: true, rejectedBy: "confirmation_required" });
    expect(r.content).toMatch(/confirm/i);
    expect((await getById(pool, bookingId))?.status).toBe("confirmed");
  });

  it("cancels in the next turn, after the patient replied; the outbox owns the message", async () => {
    const { state, bookingId } = await surfaced();
    const r = await dispatchTool(at(startTurn(state, NOW)), TOOL_NAMES.cancelBooking, {
      booking_id: bookingId,
    });
    expect(r.isError).toBe(false);
    expect(r.patientNotified).toBe(true);
    expect(r.state.status).toBe("completed");
    expect(JSON.parse(r.content)).toMatchObject({ bookingId, status: "cancelled" });
    expect((await getById(pool, bookingId))?.status).toBe("cancelled");
  });

  it("missing booking_id is invalid_args", async () => {
    const r = await dispatchTool(
      at(startTurn(emptyState(PHONE, NOW), NOW)),
      TOOL_NAMES.cancelBooking,
      {},
    );
    expect(r).toMatchObject({ isError: true, rejectedBy: "invalid_args" });
  });
});

describe("reschedule_booking gates", () => {
  async function offerAndHold(
    state: ConversationState,
  ): Promise<{ state: ConversationState; holdId: string }> {
    const d = deps();
    const avail = await dispatchTool(at(state, d), TOOL_NAMES.availability, {
      from: "2026-06-17T16:00:00Z",
      to: "2026-06-17T18:00:00Z",
      type: "cleaning",
    });
    const start = JSON.parse(avail.content).slots[0].start;
    const held = await dispatchTool(at(avail.state, d), TOOL_NAMES.hold, {
      start,
      type: "cleaning",
    });
    expect(held.isError).toBe(false);
    return { state: held.state, holdId: JSON.parse(held.content).holdId };
  }

  it("refuses when the new time was held in the current turn (the patient has not confirmed it)", async () => {
    const { state, bookingId } = await surfaced();
    const t2 = startTurn(state, NOW);
    const { state: s, holdId } = await offerAndHold(t2);
    expect(s.holdSeqs).toEqual([{ holdId, turn: 2 }]);
    const r = await dispatchTool(at(s), TOOL_NAMES.rescheduleBooking, {
      booking_id: bookingId,
      hold_id: holdId,
    });
    expect(r).toMatchObject({ isError: true, rejectedBy: "confirmation_required" });
  });

  it("refuses a hold from another conversation (foreign_hold)", async () => {
    const { state, bookingId } = await surfaced();
    const foreign = await holdSlot(
      deps(),
      { start: new Date("2026-06-17T17:00:00Z"), type: "cleaning" },
      { phone: PHONE },
    );
    const r = await dispatchTool(at(startTurn(state, NOW)), TOOL_NAMES.rescheduleBooking, {
      booking_id: bookingId,
      hold_id: foreign.id,
    });
    expect(r).toMatchObject({ isError: true, rejectedBy: "foreign_hold" });
  });

  it("moves the booking when both the booking and the hold were shown in earlier turns", async () => {
    const { state, bookingId } = await surfaced();
    const { state: s2, holdId } = await offerAndHold(startTurn(state, NOW));
    const r = await dispatchTool(at(startTurn(s2, NOW)), TOOL_NAMES.rescheduleBooking, {
      booking_id: bookingId,
      hold_id: holdId,
    });
    expect(r.isError).toBe(false);
    expect(r.patientNotified).toBe(true);
    expect(r.state.status).toBe("completed");
    expect(JSON.parse(r.content)).toMatchObject({
      bookingId: holdId,
      previousBookingId: bookingId,
    });
    expect((await getById(pool, bookingId))?.status).toBe("cancelled");
  });
});

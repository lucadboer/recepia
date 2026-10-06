import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeCalendar } from "../../src/adapters/fakes/fake-calendar";
import { FakeClock } from "../../src/adapters/fakes/fake-clock";
import { FakeMessaging } from "../../src/adapters/fakes/fake-messaging";
import { boundState, emptyState } from "../../src/agent/conversation";
import { dispatchTool, type ToolContext } from "../../src/agent/tool-registry";
import { TOOL_NAMES, toolDefs } from "../../src/agent/tool-schemas";
import { AVAILABILITY_MAX_SLOTS, OFFERED_SLOTS_MAX, ROUTINE_TYPES } from "../../src/config";
import type { Pool } from "../../src/db/pool";
import type { Deps } from "../../src/deps";
import { ensureSchema, resetDb, seedHeld, seedRule, testPool } from "../helpers/db";

const NOW = new Date("2026-06-15T12:00:00Z");
const PHONE = "+55a";

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

function ctx(): ToolContext {
  const deps: Deps = {
    pool,
    clock: new FakeClock(NOW),
    calendar: new FakeCalendar(),
    messaging: new FakeMessaging(),
    receptionPhone: "+5511999999999",
  };
  return { deps, phone: PHONE, state: emptyState(PHONE, NOW), now: NOW };
}

async function bookingCount(): Promise<number> {
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM booking");
  return rows[0].n;
}

describe("tool-registry — structural guardrails", () => {
  it("rejects an unknown tool name (closed allowlist) with no side-effects", async () => {
    const r = await dispatchTool(ctx(), "writeBooking", { sql: "DROP" });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/desconhecida/);
    expect(await bookingCount()).toBe(0);
  });

  it("get_availability records offered slots in state", async () => {
    const r = await dispatchTool(ctx(), TOOL_NAMES.availability, {
      from: NOW.toISOString(),
      to: "2026-06-15T18:00:00Z",
      type: "cleaning",
    });
    expect(r.isError).toBe(false);
    expect(r.state.offeredSlots.length).toBeGreaterThan(0);
  });

  it("rejects holding a slot never offered in this conversation (no booking written)", async () => {
    const r = await dispatchTool(ctx(), TOOL_NAMES.hold, {
      start: "2026-06-15T14:00:00Z",
      type: "cleaning",
    });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/não foi oferecido/);
    expect(await bookingCount()).toBe(0);
  });

  it("holds an offered slot and records the hold id", async () => {
    const c = ctx();
    const avail = await dispatchTool(c, TOOL_NAMES.availability, {
      from: NOW.toISOString(),
      to: "2026-06-15T18:00:00Z",
      type: "cleaning",
    });
    const start = avail.state.offeredSlots[0];
    const r = await dispatchTool({ ...c, state: avail.state }, TOOL_NAMES.hold, {
      start,
      type: "cleaning",
    });
    expect(r.isError).toBe(false);
    expect(r.state.activeHoldIds).toHaveLength(1);
    expect(await bookingCount()).toBe(1);
  });

  it("rejects confirming a hold not created in this conversation (no calendar event)", async () => {
    const c = ctx();
    const calendar = c.deps.calendar as FakeCalendar;
    const r = await dispatchTool(c, TOOL_NAMES.confirm, {
      hold_id: "00000000-0000-0000-0000-000000000000",
      patient_name: "Intruso",
    });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/não reconhecida/);
    expect(calendar.createdCount).toBe(0);
  });

  it("protects a REAL held booking from another conversation (gate 3, no writes)", async () => {
    // A genuine, still-active hold exists in the DB but was NOT created in THIS
    // conversation (state.activeHoldIds is empty) — confirm must be rejected.
    const slot = "2026-06-15T15:00:00.000Z";
    const expiresAt = new Date(NOW.getTime() + 10 * 60 * 1000);
    await seedHeld(pool, slot, "+55outsider", expiresAt);
    const { rows } = await pool.query(
      "SELECT id FROM booking WHERE patient_phone = $1 AND status = 'held'",
      ["+55outsider"],
    );
    const foreignHoldId = rows[0].id as string;

    const c = ctx(); // emptyState -> no activeHoldIds
    const calendar = c.deps.calendar as FakeCalendar;
    const messaging = c.deps.messaging as FakeMessaging;
    const r = await dispatchTool(c, TOOL_NAMES.confirm, {
      hold_id: foreignHoldId,
      patient_name: "Intruso",
    });

    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/não reconhecida/);
    expect(r.state).toBe(c.state); // state untouched
    expect(calendar.createdCount).toBe(0);
    expect(messaging.sent).toHaveLength(0);

    const after = await pool.query("SELECT status, google_event_id FROM booking WHERE id = $1", [
      foreignHoldId,
    ]);
    expect(after.rows[0].status).toBe("held"); // still held, not confirmed
    expect(after.rows[0].google_event_id).toBeNull();
    expect(await countAll("audit_log")).toBe(0); // gate rejected before any write
    expect(await countAll("patient_consent")).toBe(0);
  });

  it("unknown tool and non-offered slot leave audit_log and patient_consent untouched", async () => {
    await dispatchTool(ctx(), "writeBooking", { sql: "DROP" });
    await dispatchTool(ctx(), TOOL_NAMES.hold, { start: "2026-06-15T14:00:00Z", type: "cleaning" });
    expect(await bookingCount()).toBe(0);
    expect(await countAll("audit_log")).toBe(0);
    expect(await countAll("patient_consent")).toBe(0);
  });
});

async function countAll(table: string): Promise<number> {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0].n;
}

describe("tool schemas + input validation", () => {
  it("exposes exactly the four allowlisted tools, no duplicates", () => {
    const names = toolDefs.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length); // no duplicates
    expect([...names].sort()).toEqual([...Object.values(TOOL_NAMES)].sort());
  });

  it("availability + hold expose `type` as the ROUTINE_TYPES enum", () => {
    for (const key of [TOOL_NAMES.availability, TOOL_NAMES.hold]) {
      const def = toolDefs.find((t) => t.name === key);
      const schema = def?.inputSchema as { properties: { type: { enum: string[] } } };
      expect(schema.properties.type.enum).toEqual([...ROUTINE_TYPES]);
    }
  });

  it.each([
    [TOOL_NAMES.availability, { from: NOW.toISOString(), type: "cleaning" }], // missing `to`
    [TOOL_NAMES.hold, { type: "cleaning" }], // missing `start`
    [TOOL_NAMES.hold, { start: "not-a-date", type: "cleaning" }], // invalid date
    [TOOL_NAMES.confirm, { hold_id: ["array"], patient_name: "X" }], // wrong type
    [TOOL_NAMES.confirm, null], // null input
  ])("rejects malformed input for %s with no writes", async (name, input) => {
    const r = await dispatchTool(ctx(), name, input);
    expect(r.isError).toBe(true);
    expect(await bookingCount()).toBe(0);
    expect(await countAll("audit_log")).toBe(0);
    expect(await countAll("patient_consent")).toBe(0);
  });
});

describe("tool-registry × state bounds (T239)", () => {
  it("caps a wide get_availability to AVAILABILITY_MAX_SLOTS, flags truncation, and records EXACTLY what the model saw", async () => {
    for (let wd = 2; wd <= 5; wd++) {
      await seedRule(pool, { weekday: wd, startTime: "09:00", endTime: "18:00", capacity: 2 });
    }
    const c = ctx();
    const r = await dispatchTool(c, TOOL_NAMES.availability, {
      from: NOW.toISOString(),
      to: "2026-06-20T00:00:00Z", // the whole business week: 5 × 18 = 90 free slots
      type: "cleaning",
    });
    const payload = JSON.parse(r.content) as { slots: { start: string }[]; truncated: boolean };
    expect(payload.truncated).toBe(true);
    expect(payload.slots).toHaveLength(AVAILABILITY_MAX_SLOTS);
    expect(payload.slots[0].start).toBe("2026-06-15T14:00:00.000Z"); // the EARLIEST are kept
    expect(r.state.offeredSlots).toEqual(payload.slots.map((s) => s.start));
    // Every slot the model can quote survives the state bound (the cap is below OFFERED_SLOTS_MAX).
    expect(AVAILABILITY_MAX_SLOTS).toBeLessThanOrEqual(OFFERED_SLOTS_MAX);
    const bounded = boundState(r.state, NOW);
    expect(bounded.offeredSlots).toEqual(r.state.offeredSlots);
    // And the last exposed slot is holdable.
    const last = payload.slots.at(-1)?.start as string;
    const hold = await dispatchTool({ ...c, state: bounded }, TOOL_NAMES.hold, {
      start: last,
      type: "cleaning",
    });
    expect(hold.isError).toBe(false);
  });

  it("a narrow get_availability is not truncated", async () => {
    const r = await dispatchTool(ctx(), TOOL_NAMES.availability, {
      from: NOW.toISOString(),
      to: "2026-06-15T18:00:00Z",
      type: "cleaning",
    });
    const payload = JSON.parse(r.content) as { slots: unknown[]; truncated: boolean };
    expect(payload.truncated).toBe(false);
    expect(payload.slots.length).toBeLessThanOrEqual(AVAILABILITY_MAX_SLOTS);
  });

  it("rejects holding a slot that was offered earlier but is now in the past (gate 2 after boundState)", async () => {
    const c = ctx();
    // Offered at 09:00, slot at 11:00 local — then the clock moves past the slot start.
    const offered = await dispatchTool(c, TOOL_NAMES.availability, {
      from: NOW.toISOString(),
      to: "2026-06-15T18:00:00Z",
      type: "cleaning",
    });
    const stale = offered.state.offeredSlots[0]; // 2026-06-15T14:00:00.000Z
    const later = new Date("2026-06-15T14:30:00Z"); // 30 min after that slot started
    const bounded = boundState(offered.state, later);
    expect(bounded.offeredSlots).not.toContain(stale);

    const r = await dispatchTool({ ...c, state: bounded, now: later }, TOOL_NAMES.hold, {
      start: stale,
      type: "cleaning",
    });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/não foi oferecido/);
    expect(await bookingCount()).toBe(0);
  });
});

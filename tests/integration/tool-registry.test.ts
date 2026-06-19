import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeCalendar } from "../../src/adapters/fakes/fake-calendar";
import { FakeClock } from "../../src/adapters/fakes/fake-clock";
import { FakeMessaging } from "../../src/adapters/fakes/fake-messaging";
import { emptyState } from "../../src/agent/conversation";
import { dispatchTool, type ToolContext } from "../../src/agent/tool-registry";
import { TOOL_NAMES } from "../../src/agent/tool-schemas";
import type { Pool } from "../../src/db/pool";
import type { Deps } from "../../src/deps";
import { ensureSchema, resetDb, seedRule, testPool } from "../helpers/db";

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
});

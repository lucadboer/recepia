import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeCalendar } from "../../src/adapters/fakes/fake-calendar";
import { FakeClock } from "../../src/adapters/fakes/fake-clock";
import { FakeMessaging } from "../../src/adapters/fakes/fake-messaging";
import type { Pool } from "../../src/db/pool";
import type { Deps } from "../../src/deps";
import { OutOfScopeError } from "../../src/domain/errors";
import { getAvailability } from "../../src/tools/get-availability";
import { holdSlot } from "../../src/tools/hold-slot";
import { screenRoutineType } from "../../src/tools/screening";
import { countAudit, ensureSchema, resetDb, seedRule, testPool } from "../helpers/db";

const NOW = new Date("2026-06-15T12:00:00Z");
const SLOT = new Date("2026-06-15T14:00:00Z");
const RECEPTION = "+5511999999999";

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

function deps(messaging: FakeMessaging): Deps {
  return {
    pool,
    clock: new FakeClock(NOW),
    calendar: new FakeCalendar(),
    messaging,
    receptionPhone: RECEPTION,
  };
}

describe("US3 — escalate non-routine requests", () => {
  it("escalates a non-routine request and creates no booking", async () => {
    const messaging = new FakeMessaging();
    const ok = await screenRoutineType(deps(messaging), "invisalign", "Paciente pediu Invisalign");

    expect(ok).toBe(false);
    expect(messaging.sent.filter((m) => m.to === RECEPTION)).toHaveLength(1);
    expect(await countAudit(pool, "escalated")).toBe(1);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM booking");
    expect(rows[0].n).toBe(0);
  });

  it("rejects a non-routine type at the deterministic tool entry (OutOfScopeError, nothing persisted)", async () => {
    const d = deps(new FakeMessaging());
    await expect(
      getAvailability(d, { from: NOW, to: new Date("2026-06-15T18:00:00Z") }, "invisalign"),
    ).rejects.toBeInstanceOf(OutOfScopeError);
    await expect(
      holdSlot(d, { start: SLOT, type: "orthodontics" }, { phone: "+55a" }),
    ).rejects.toBeInstanceOf(OutOfScopeError);

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM booking");
    expect(rows[0].n).toBe(0);
  });

  it("lets a routine type pass screening without escalating", async () => {
    const messaging = new FakeMessaging();
    const ok = await screenRoutineType(deps(messaging), "cleaning", "Paciente quer limpeza");
    expect(ok).toBe(true);
    expect(messaging.sent).toHaveLength(0);
    expect(await countAudit(pool, "escalated")).toBe(0);
  });
});

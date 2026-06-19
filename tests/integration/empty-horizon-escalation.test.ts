import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeCalendar } from "../../src/adapters/fakes/fake-calendar";
import { FakeClock } from "../../src/adapters/fakes/fake-clock";
import { FakeMessaging } from "../../src/adapters/fakes/fake-messaging";
import type { Pool } from "../../src/db/pool";
import type { Deps } from "../../src/deps";
import { offerAlternativesOrEscalate } from "../../src/tools/alternatives";
import { countAudit, ensureSchema, resetDb, testPool } from "../helpers/db";

const NOW = new Date("2026-06-15T12:00:00Z");
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
  await resetDb(pool); // no capacity rules → nothing is bookable
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

describe("offerAlternativesOrEscalate (US2 — empty horizon escalates)", () => {
  it("escalates to reception and creates no booking when nothing is free in the horizon", async () => {
    const messaging = new FakeMessaging();
    const slots = await offerAlternativesOrEscalate(
      deps(messaging),
      { from: NOW, to: new Date("2026-06-15T18:00:00Z") },
      "cleaning",
      3,
    );

    expect(slots).toHaveLength(0);
    expect(messaging.sent.filter((m) => m.to === RECEPTION)).toHaveLength(1);
    expect(await countAudit(pool, "escalated")).toBe(1);

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM booking");
    expect(rows[0].n).toBe(0);
  });
});

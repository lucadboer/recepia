import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeCalendar } from "../../src/adapters/fakes/fake-calendar";
import { FakeClock } from "../../src/adapters/fakes/fake-clock";
import { FakeMessaging } from "../../src/adapters/fakes/fake-messaging";
import type { Deps } from "../../src/deps";
import type { Pool } from "../../src/db/pool";
import { escalateToHuman } from "../../src/tools/escalate-to-human";
import { countAudit, ensureSchema, resetDb, testPool } from "../helpers/db";

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

function makeDeps(messaging: FakeMessaging): Deps {
  return {
    pool,
    clock: new FakeClock(new Date("2026-06-15T12:00:00Z")),
    calendar: new FakeCalendar(),
    messaging,
    receptionPhone: "+5511999999999",
  };
}

describe("escalate_to_human", () => {
  it("notifies reception, creates no booking, and writes an audit row", async () => {
    const messaging = new FakeMessaging();
    await escalateToHuman(makeDeps(messaging), "non_routine", "Paciente pediu Invisalign");

    expect(messaging.sent).toHaveLength(1);
    expect(messaging.sent[0].to).toBe("+5511999999999");
    expect(messaging.sent[0].body).toContain("recepção");

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM booking");
    expect(rows[0].n).toBe(0);
    expect(await countAudit(pool, "escalated")).toBe(1);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeCalendar } from "../../src/adapters/fakes/fake-calendar";
import { FakeClock } from "../../src/adapters/fakes/fake-clock";
import { FakeMessaging } from "../../src/adapters/fakes/fake-messaging";
import { hasConsent, recordConsent, recordOptOut } from "../../src/agent/consent";
import type { Pool } from "../../src/db/pool";
import type { Deps } from "../../src/deps";
import { countAudit, ensureSchema, resetDb, testPool } from "../helpers/db";

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

describe("consent ledger + gate (LGPD)", () => {
  it("is false for an unknown phone", async () => {
    expect(await hasConsent(deps(), PHONE)).toBe(false);
  });

  it("records opt-in (audited) → hasConsent true", async () => {
    const d = deps();
    await recordConsent(d, PHONE);
    expect(await hasConsent(d, PHONE)).toBe(true);
    expect(await countAudit(pool, "consent_recorded")).toBe(1);
  });

  it("records opt-out (audited) → hasConsent false", async () => {
    const d = deps();
    await recordConsent(d, PHONE);
    await recordOptOut(d, PHONE);
    expect(await hasConsent(d, PHONE)).toBe(false);
    expect(await countAudit(pool, "consent_revoked")).toBe(1);
  });

  it("latest row wins (opt-in → opt-out → opt-in)", async () => {
    const d = deps();
    await recordConsent(d, PHONE);
    await recordOptOut(d, PHONE);
    await recordConsent(d, PHONE);
    expect(await hasConsent(d, PHONE)).toBe(true);
  });
});

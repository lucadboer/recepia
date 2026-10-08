import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeCalendar } from "../../src/adapters/fakes/fake-calendar";
import { FakeClock } from "../../src/adapters/fakes/fake-clock";
import { FakeMessaging } from "../../src/adapters/fakes/fake-messaging";
import { HOLD_TTL_MS } from "../../src/config";
import type { Pool } from "../../src/db/pool";
import { flagEventCleanup } from "../../src/db/repositories/booking-repo";
import type { Deps } from "../../src/deps";
import { expireHolds, removeAbandonedEvents } from "../../src/jobs/expire-holds";
import { confirmBooking } from "../../src/tools/confirm-booking";
import { holdSlot } from "../../src/tools/hold-slot";
import {
  countActiveHolds,
  countAudit,
  ensureSchema,
  resetDb,
  seedRule,
  testPool,
} from "../helpers/db";
import { interceptingPool } from "../helpers/pool";

const NOW = new Date("2026-06-15T12:00:00Z");
const SLOT = new Date("2026-06-15T15:00:00Z"); // lead 3h: still bookable after the TTL elapses
const OTHER_SLOT = new Date("2026-06-15T16:00:00Z");
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

function makeDeps(clock: FakeClock, p: Pool = pool): Deps {
  return {
    pool: p,
    clock,
    calendar: new FakeCalendar(),
    messaging: new FakeMessaging(),
    receptionPhone: RECEPTION,
  };
}

async function statusOf(id: string): Promise<string> {
  const { rows } = await pool.query("SELECT status FROM booking WHERE id = $1", [id]);
  return rows[0].status;
}

describe("expireHolds — the scheduled sweep (T245)", () => {
  it("expires every due hold, leaves fresh ones, and audits exactly one hold_expired per id", async () => {
    const clock = new FakeClock(NOW);
    const d = makeDeps(clock);
    const a = await holdSlot(d, { start: SLOT, type: "cleaning" }, { phone: "+55a" });
    const b = await holdSlot(d, { start: OTHER_SLOT, type: "cleaning" }, { phone: "+55b" });
    clock.advance(HOLD_TTL_MS - 60_000); // 1 min before a/b expire
    const fresh = await holdSlot(d, { start: SLOT, type: "cleaning" }, { phone: "+55c" });
    clock.advance(120_000); // a and b are due; `fresh` has ~8 min left

    const expired = await expireHolds(d);

    expect(expired).toBe(2);
    expect(await statusOf(a.id)).toBe("expired");
    expect(await statusOf(b.id)).toBe("expired");
    expect(await statusOf(fresh.id)).toBe("held");
    expect(await countAudit(pool, "hold_expired")).toBe(2);
    const audited = await pool.query(
      "SELECT entity_id FROM audit_log WHERE action = 'hold_expired' ORDER BY entity_id",
    );
    expect(audited.rows.map((r) => r.entity_id).sort()).toEqual([a.id, b.id].sort());
    expect(await countActiveHolds(pool, SLOT, clock.now())).toBe(1);
  });

  it("is a no-op when nothing is due", async () => {
    const clock = new FakeClock(NOW);
    const d = makeDeps(clock);
    await holdSlot(d, { start: SLOT, type: "cleaning" }, { phone: "+55a" });
    expect(await expireHolds(d)).toBe(0);
    expect(await countAudit(pool, "hold_expired")).toBe(0);
  });

  it("race with the lazy reclaim: audits only what IT expired — never a duplicate hold_expired [T234]", async () => {
    const clock = new FakeClock(NOW);
    const real = makeDeps(clock);
    const victim = await holdSlot(real, { start: SLOT, type: "cleaning" }, { phone: "+55a" });
    clock.advance(HOLD_TTL_MS + 1000); // victim is due

    // Right before the sweep's UPDATE runs, another request lazily reclaims the same slot
    // (holdSlot expires `victim` and audits hold_expired itself, in its own transaction).
    let raced = false;
    const racingPool = interceptingPool(pool, {
      before: async (sql) => {
        // Match the sweep's UPDATE only (a SELECT-then-UPDATE sweep would double-audit here).
        if (
          !raced &&
          sql.startsWith("UPDATE booking SET status = 'expired'") &&
          sql.includes("expires_at <= $1")
        ) {
          raced = true;
          await holdSlot(real, { start: SLOT, type: "cleaning" }, { phone: "+55late" });
        }
      },
    });

    const expired = await expireHolds(makeDeps(clock, racingPool));

    expect(raced).toBe(true);
    expect(expired).toBe(0); // the lazy reclaim won
    expect(await statusOf(victim.id)).toBe("expired");
    // Exactly ONE hold_expired for the victim (from the lazy reclaim), not two.
    const audited = await pool.query(
      "SELECT entity_id FROM audit_log WHERE action = 'hold_expired'",
    );
    expect(audited.rows.map((r) => r.entity_id)).toEqual([victim.id]);
  });
});

describe("removeAbandonedEvents — events left by a turn that lost its message (008 review)", () => {
  it("removes the event of a flagged hold once it ended unconfirmed, and only then", async () => {
    const clock = new FakeClock(NOW);
    const d = makeDeps(clock);
    const calendar = d.calendar as FakeCalendar;
    const hold = await holdSlot(d, { start: SLOT, type: "cleaning" }, { phone: "+55a" });
    await calendar.createEvent({
      idempotencyKey: hold.id,
      start: SLOT,
      end: new Date(SLOT.getTime() + 30 * 60_000),
      title: "Consulta de rotina (cleaning)",
      patientName: "Ana",
      patientPhone: "+55a",
    });
    await flagEventCleanup(pool, hold.id);

    expect(await removeAbandonedEvents(d)).toBe(0); // still held: the new holder may confirm it
    expect(calendar.events.has(hold.id)).toBe(true);

    clock.advance(HOLD_TTL_MS + 1);
    await expireHolds(d);
    expect(await removeAbandonedEvents(d)).toBe(1);
    expect(calendar.events.has(hold.id)).toBe(false);
    expect(await removeAbandonedEvents(d)).toBe(0); // done once
  });

  it("never touches a flagged hold that was confirmed after all", async () => {
    const clock = new FakeClock(NOW);
    const d = makeDeps(clock);
    const calendar = d.calendar as FakeCalendar;
    const hold = await holdSlot(d, { start: SLOT, type: "cleaning" }, { phone: "+55a" });
    await flagEventCleanup(pool, hold.id);
    await confirmBooking(d, hold.id, { phone: "+55a", name: "Ana" });
    clock.advance(HOLD_TTL_MS + 1);
    await expireHolds(d);
    expect(await removeAbandonedEvents(d)).toBe(0);
    expect(calendar.events.has(hold.id)).toBe(true);
    expect(await statusOf(hold.id)).toBe("confirmed");
  });

  it("an event that cannot be removed becomes a reception cleanup notice", async () => {
    const clock = new FakeClock(NOW);
    const d = makeDeps(clock);
    (d.calendar as FakeCalendar).deleteFailAlways = true;
    const hold = await holdSlot(d, { start: SLOT, type: "cleaning" }, { phone: "+55a" });
    await flagEventCleanup(pool, hold.id);
    clock.advance(HOLD_TTL_MS + 1);
    await expireHolds(d);
    expect(await removeAbandonedEvents(d)).toBe(1);
    const notices = await pool.query(
      "SELECT dedupe_key FROM outbox_message WHERE kind = 'reception_notice'",
    );
    expect(notices.rows).toEqual([{ dedupe_key: `calendar_cleanup:${hold.id}` }]);
    expect(await removeAbandonedEvents(d)).toBe(0);
  });
});

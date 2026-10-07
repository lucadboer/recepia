import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeCalendar } from "../../src/adapters/fakes/fake-calendar";
import { FakeClock } from "../../src/adapters/fakes/fake-clock";
import { FakeMessaging } from "../../src/adapters/fakes/fake-messaging";
import { parseRetentionArgs } from "../../src/cli/retention-purge";
import type { Pool } from "../../src/db/pool";
import { purgeInactive, RETENTION_DAYS } from "../../src/jobs/retention";
import { startJobs, stopJobs } from "../../src/jobs/scheduler";
import { countAudit, ensureSchema, resetDb, testPool } from "../helpers/db";

// T536 — LGPD retention (owner decision T222, 2026-10-06): purge conversation state and terminal
// outbox messages after 90 days without activity; keep consent, audit and pending messages.

const NOW = new Date("2026-10-07T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);

let pool: Pool;
beforeAll(async () => {
  pool = testPool();
  await ensureSchema(pool);
});
afterAll(async () => {
  await pool.end();
});

async function seedState(phone: string, updatedAt: Date): Promise<void> {
  await pool.query(
    "INSERT INTO conversation_state (phone, state, version, updated_at) VALUES ($1, '{}'::jsonb, 1, $2)",
    [phone, updatedAt],
  );
}
async function seedOutbox(status: string, createdAt: Date): Promise<void> {
  await pool.query(
    `INSERT INTO outbox_message (kind, to_phone, conversation_phone, body, status, created_at, sent_at, next_attempt_at)
     VALUES ('booking_confirmation', '+5531900000101', '+5531900000101', 'x', $1, $2, $3, $2)`,
    [status, createdAt, status === "sent" ? createdAt : null],
  );
}
async function count(table: string): Promise<number> {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0].n;
}

beforeEach(async () => {
  await resetDb(pool);
  await seedState("+5531900000101", daysAgo(120)); // old → purged
  await seedState("+5531900000102", daysAgo(91)); // old → purged
  await seedState("+5531900000103", daysAgo(10)); // recent → kept
  await seedOutbox("sent", daysAgo(100)); // purged
  await seedOutbox("failed", daysAgo(100)); // purged
  await seedOutbox("cancelled", daysAgo(95)); // purged
  await seedOutbox("pending", daysAgo(200)); // never purged
  await seedOutbox("sent", daysAgo(5)); // recent → kept
  await pool.query(
    "INSERT INTO patient_consent (phone, state, source, created_at) VALUES ('+5531900000101', 'opted_in', 'x', $1)",
    [daysAgo(300)],
  );
});

describe("purgeInactive", () => {
  it("defaults to 90 days and deletes exactly the eligible rows, auditing counts only", async () => {
    expect(RETENTION_DAYS).toBe(90);
    const r = await purgeInactive(pool, NOW);
    expect(r).toMatchObject({
      conversationStates: 2,
      outboxMessages: 3,
      dryRun: false,
      olderThanDays: 90,
    });
    expect(await count("conversation_state")).toBe(1);
    expect(await count("outbox_message")).toBe(2);
    const { rows } = await pool.query("SELECT status FROM outbox_message ORDER BY created_at");
    expect(rows.map((x) => x.status)).toEqual(["pending", "sent"]);
    expect(await count("patient_consent")).toBe(1);
    expect(await countAudit(pool, "retention_purged")).toBe(1);
    const { rows: audit } = await pool.query(
      "SELECT actor, payload FROM audit_log WHERE action = 'retention_purged'",
    );
    expect(audit[0].actor).toBe("system");
    expect(audit[0].payload).toEqual({
      conversationStates: 2,
      outboxMessages: 3,
      olderThanDays: 90,
      cutoff: daysAgo(90).toISOString(),
    });
    expect(JSON.stringify(audit[0].payload)).not.toContain("+55");
  });

  it("dry run reports the same counts and changes nothing (no audit row)", async () => {
    const r = await purgeInactive(pool, NOW, { dryRun: true });
    expect(r).toMatchObject({ conversationStates: 2, outboxMessages: 3, dryRun: true });
    expect(await count("conversation_state")).toBe(3);
    expect(await count("outbox_message")).toBe(5);
    expect(await countAudit(pool, "retention_purged")).toBe(0);
  });

  it("a shorter window purges recent terminal rows too, never pending ones; a second run finds nothing", async () => {
    const r = await purgeInactive(pool, NOW, { olderThanDays: 1 });
    expect(r).toMatchObject({ conversationStates: 3, outboxMessages: 4 });
    expect(await count("outbox_message")).toBe(1);
    const again = await purgeInactive(pool, NOW, { olderThanDays: 1 });
    expect(again).toMatchObject({ conversationStates: 0, outboxMessages: 0 });
    expect(await countAudit(pool, "retention_purged")).toBe(2); // every run is audited
  });

  it("rejects a non-positive window", async () => {
    await expect(purgeInactive(pool, NOW, { olderThanDays: 0 })).rejects.toThrow(/olderThanDays/);
  });
});

describe("retention wiring", () => {
  it("the scheduler runs a daily retention job", () => {
    const deps = {
      pool,
      clock: new FakeClock(NOW),
      calendar: new FakeCalendar(),
      messaging: new FakeMessaging(),
      receptionPhone: "+5531900000000",
    };
    const jobs = startJobs(deps);
    try {
      expect(jobs.map((j) => j.name)).toContain("retention");
    } finally {
      stopJobs(jobs);
    }
  });

  it("CLI arguments: --dry-run and --days N", () => {
    expect(parseRetentionArgs([])).toEqual({ dryRun: false, olderThanDays: 90 });
    expect(parseRetentionArgs(["--dry-run", "--days", "30"])).toEqual({
      dryRun: true,
      olderThanDays: 30,
    });
    expect(() => parseRetentionArgs(["--days", "0"])).toThrow(/--days/);
    expect(() => parseRetentionArgs(["--days"])).toThrow(/--days/);
    expect(() => parseRetentionArgs(["--force"])).toThrow(/unknown/);
  });
});

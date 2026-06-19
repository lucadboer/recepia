import { migrate } from "../../src/db/migrate";
import { makePool } from "../../src/db/pool";
import type { Pool } from "../../src/db/pool";

export function testPool(): Pool {
  return makePool();
}

export async function ensureSchema(pool: Pool): Promise<void> {
  await migrate(pool);
}

/** Clear all mutable + capacity tables so each test starts clean. */
export async function resetDb(pool: Pool): Promise<void> {
  await pool.query("TRUNCATE booking, audit_log, capacity_rule, capacity_override RESTART IDENTITY");
}

export async function seedRule(
  pool: Pool,
  r: { weekday: number; startTime: string; endTime: string; capacity: number },
): Promise<void> {
  await pool.query(
    "INSERT INTO capacity_rule (weekday, start_time, end_time, capacity) VALUES ($1, $2, $3, $4)",
    [r.weekday, r.startTime, r.endTime, r.capacity],
  );
}

export async function seedOverride(
  pool: Pool,
  o: { date: string; startTime: string; endTime: string; capacity: number },
): Promise<void> {
  await pool.query(
    "INSERT INTO capacity_override (date, start_time, end_time, capacity) VALUES ($1, $2, $3, $4)",
    [o.date, o.startTime, o.endTime, o.capacity],
  );
}

export async function countAudit(pool: Pool, action: string): Promise<number> {
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action = $1", [
    action,
  ]);
  return rows[0].n;
}

export async function countActiveHolds(pool: Pool, start: Date, now: Date): Promise<number> {
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM booking WHERE start_ts = $1 AND status = 'held' AND expires_at > $2",
    [start, now],
  );
  return rows[0].n;
}

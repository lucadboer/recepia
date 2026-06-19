import { migrate } from "../../src/db/migrate";
import type { Pool } from "../../src/db/pool";
import { makePool } from "../../src/db/pool";

export function testPool(): Pool {
  return makePool();
}

export async function ensureSchema(pool: Pool): Promise<void> {
  await migrate(pool);
}

/** Clear all mutable + capacity tables so each test starts clean. */
export async function resetDb(pool: Pool): Promise<void> {
  await pool.query(
    "TRUNCATE booking, audit_log, capacity_rule, capacity_override RESTART IDENTITY",
  );
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

const SLOT_MS = 30 * 60 * 1000;

export async function seedConfirmed(
  pool: Pool,
  startIso: string,
  phone = "+550000",
): Promise<void> {
  const start = new Date(startIso);
  const end = new Date(start.getTime() + SLOT_MS);
  await pool.query(
    `INSERT INTO booking (patient_phone, patient_name, appointment_type, start_ts, end_ts, status, google_event_id, created_via, consent_at)
     VALUES ($1, 'Teste', 'cleaning', $2, $3, 'confirmed', $4, 'ai', now())`,
    [phone, start, end, `evt_${phone}_${startIso}`],
  );
}

export async function seedHeld(
  pool: Pool,
  startIso: string,
  phone: string,
  expiresAt: Date,
): Promise<void> {
  const start = new Date(startIso);
  const end = new Date(start.getTime() + SLOT_MS);
  await pool.query(
    `INSERT INTO booking (patient_phone, appointment_type, start_ts, end_ts, status, expires_at, created_via)
     VALUES ($1, 'cleaning', $2, $3, 'held', $4, 'ai')`,
    [phone, start, end, expiresAt],
  );
}

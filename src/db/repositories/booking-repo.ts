import type { AppointmentType } from "../../config";
import type { Booking } from "../../domain/types";
import type { Pool, PoolClient } from "../pool";

type Queryable = Pool | PoolClient;

interface BookingRow {
  id: string;
  patient_name: string | null;
  patient_phone: string;
  appointment_type: AppointmentType;
  start_ts: Date;
  end_ts: Date;
  status: Booking["status"];
  expires_at: Date | null;
  google_event_id: string | null;
  attended_by: string | null;
  created_via: "ai" | "human";
  consent_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export function rowToBooking(r: BookingRow): Booking {
  return {
    id: r.id,
    patientName: r.patient_name,
    patientPhone: r.patient_phone,
    appointmentType: r.appointment_type,
    start: r.start_ts,
    end: r.end_ts,
    status: r.status,
    expiresAt: r.expires_at,
    googleEventId: r.google_event_id,
    attendedBy: r.attended_by,
    createdVia: r.created_via,
    consentAt: r.consent_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Lazy reclaim: expire this slot's holds whose TTL elapsed, freeing their seats now. */
export async function reclaimExpiredHoldsForSlot(
  q: Queryable,
  start: Date,
  now: Date,
): Promise<void> {
  await q.query(
    "UPDATE booking SET status = 'expired', expires_at = NULL, updated_at = now() WHERE start_ts = $1 AND status = 'held' AND expires_at <= $2",
    [start, now],
  );
}

/** Seats currently occupying a slot (every state except cancelled/expired). */
export async function occupiedSeats(q: Queryable, start: Date): Promise<number[]> {
  const { rows } = await q.query(
    "SELECT seat FROM booking WHERE start_ts = $1 AND status NOT IN ('cancelled','expired') ORDER BY seat",
    [start],
  );
  return rows.map((r) => r.seat as number);
}

/** Map of slot-start (ms) -> active count, for a range. One query for availability. */
export async function countActiveInRange(
  q: Queryable,
  from: Date,
  to: Date,
  now: Date,
): Promise<Map<number, number>> {
  const { rows } = await q.query(
    `SELECT start_ts, count(*)::int AS n FROM booking
     WHERE start_ts >= $1 AND start_ts < $2
       AND (status IN ('confirmed','patient_confirmed','done') OR (status = 'held' AND expires_at > $3))
     GROUP BY start_ts`,
    [from, to, now],
  );
  const map = new Map<number, number>();
  for (const r of rows) map.set(new Date(r.start_ts).getTime(), r.n);
  return map;
}

export async function findActiveHold(
  q: Queryable,
  phone: string,
  start: Date,
  now: Date,
): Promise<Booking | null> {
  const { rows } = await q.query(
    `SELECT * FROM booking
     WHERE patient_phone = $1 AND start_ts = $2 AND status = 'held' AND expires_at > $3
     LIMIT 1`,
    [phone, start, now],
  );
  return rows[0] ? rowToBooking(rows[0]) : null;
}

export async function insertHold(
  q: Queryable,
  input: {
    patientPhone: string;
    appointmentType: AppointmentType;
    start: Date;
    end: Date;
    expiresAt: Date;
    seat: number;
  },
): Promise<Booking> {
  const { rows } = await q.query(
    `INSERT INTO booking (patient_phone, appointment_type, start_ts, end_ts, status, expires_at, created_via, seat)
     VALUES ($1, $2, $3, $4, 'held', $5, 'ai', $6)
     RETURNING *`,
    [
      input.patientPhone,
      input.appointmentType,
      input.start,
      input.end,
      input.expiresAt,
      input.seat,
    ],
  );
  return rowToBooking(rows[0]);
}

export async function getById(q: Queryable, id: string): Promise<Booking | null> {
  const { rows } = await q.query("SELECT * FROM booking WHERE id = $1", [id]);
  return rows[0] ? rowToBooking(rows[0]) : null;
}

/** Flip a still-held booking to confirmed. Returns null if it is no longer held (race/expiry). */
export async function confirmHeld(
  q: Queryable,
  id: string,
  patientName: string,
  eventId: string,
  consentAt: Date,
): Promise<Booking | null> {
  const { rows } = await q.query(
    `UPDATE booking
     SET status = 'confirmed', patient_name = $2, google_event_id = $3, consent_at = $4,
         expires_at = NULL, updated_at = now()
     WHERE id = $1 AND status = 'held'
     RETURNING *`,
    [id, patientName, eventId, consentAt],
  );
  return rows[0] ? rowToBooking(rows[0]) : null;
}

/** Release a still-held booking (frees the seat). Used on unrecoverable calendar failure. */
export async function releaseHeld(q: Queryable, id: string): Promise<void> {
  await q.query(
    "UPDATE booking SET status = 'expired', expires_at = NULL, updated_at = now() WHERE id = $1 AND status = 'held'",
    [id],
  );
}

/** Sweep: expire all holds past their TTL. Returns the number expired. */
export async function expireDueHolds(q: Queryable, now: Date): Promise<number> {
  const { rowCount } = await q.query(
    "UPDATE booking SET status = 'expired', expires_at = NULL, updated_at = now() WHERE status = 'held' AND expires_at <= $1",
    [now],
  );
  return rowCount ?? 0;
}

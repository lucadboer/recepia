import type { AppointmentType } from "../../config.ts";
import type { Booking } from "../../domain/types.ts";
import type { Pool, PoolClient } from "../pool.ts";

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
  cancelled_at: Date | null;
  rescheduled_from: string | null;
  reminder_sent_at: Date | null;
  unconfirmed_notice_at: Date | null;
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
    cancelledAt: r.cancelled_at,
    rescheduledFrom: r.rescheduled_from,
    reminderSentAt: r.reminder_sent_at ?? null,
    unconfirmedNoticeAt: r.unconfirmed_notice_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Lazy reclaim: expire this slot's holds whose TTL elapsed, freeing their seats now.
 * Returns the ids that were expired so the caller can audit each (Constitution V).
 */
export async function reclaimExpiredHoldsForSlot(
  q: Queryable,
  start: Date,
  now: Date,
): Promise<string[]> {
  const { rows } = await q.query(
    "UPDATE booking SET status = 'expired', expires_at = NULL, updated_at = now() WHERE start_ts = $1 AND status = 'held' AND expires_at <= $2 RETURNING id",
    [start, now],
  );
  return rows.map((r) => r.id as string);
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

/**
 * Flip a still-held booking to confirmed. Returns null if it is no longer held (race/expiry).
 * `rescheduledFrom` (006) records the booking this one replaces; the database allows that link
 * only once per booking (`booking_rescheduled_from_uq`). `aliveAt` (006 review) refuses a hold
 * whose TTL ran out during the calendar call even if no sweep has expired it yet.
 */
export async function confirmHeld(
  q: Queryable,
  id: string,
  patientName: string,
  eventId: string,
  consentAt: Date,
  rescheduledFrom: string | null = null,
  aliveAt: Date | null = null,
): Promise<Booking | null> {
  const { rows } = await q.query(
    `UPDATE booking
     SET status = 'confirmed', patient_name = $2, google_event_id = $3, consent_at = $4,
         expires_at = NULL, rescheduled_from = $5, updated_at = now()
     WHERE id = $1 AND status = 'held' AND ($6::timestamptz IS NULL OR expires_at > $6)
     RETURNING *`,
    [id, patientName, eventId, consentAt, rescheduledFrom, aliveAt],
  );
  return rows[0] ? rowToBooking(rows[0]) : null;
}

/** The patient's active bookings that have not started yet, earliest first (006 FR-601). */
export async function findUpcomingForPhone(
  q: Queryable,
  phone: string,
  now: Date,
): Promise<Booking[]> {
  const { rows } = await q.query(
    `SELECT * FROM booking
     WHERE patient_phone = $1 AND status IN ('confirmed','patient_confirmed') AND start_ts > $2
     ORDER BY start_ts`,
    [phone, now],
  );
  return rows.map(rowToBooking);
}

/** Row lock for a cancel/reschedule transaction (006). Null when the id does not exist. */
export async function lockBookingForUpdate(q: PoolClient, id: string): Promise<Booking | null> {
  const { rows } = await q.query("SELECT * FROM booking WHERE id = $1 FOR UPDATE", [id]);
  return rows[0] ? rowToBooking(rows[0]) : null;
}

/** Cancel an active booking (frees its seat). Null when it is not active any more (006 FR-604). */
export async function cancelActive(q: Queryable, id: string, now: Date): Promise<Booking | null> {
  const { rows } = await q.query(
    `UPDATE booking SET status = 'cancelled', cancelled_at = $2, updated_at = now()
     WHERE id = $1 AND status IN ('confirmed','patient_confirmed')
     RETURNING *`,
    [id, now],
  );
  return rows[0] ? rowToBooking(rows[0]) : null;
}

/** The booking that replaced `id` through a reschedule, if any (006 FR-608 idempotency). */
export async function findRescheduleOf(q: Queryable, id: string): Promise<Booking | null> {
  const { rows } = await q.query("SELECT * FROM booking WHERE rescheduled_from = $1", [id]);
  return rows[0] ? rowToBooking(rows[0]) : null;
}

/**
 * Flag a hold whose calendar event a turn that lost its inbound message left behind (008 review):
 * the hold sweep removes that event if the hold ends unconfirmed; a confirmed booking keeps it.
 */
export async function flagEventCleanup(q: Queryable, id: string): Promise<void> {
  await q.query(
    "UPDATE booking SET event_cleanup_pending = true WHERE id = $1 AND status IN ('held', 'expired')",
    [id],
  );
}

/** Holds that ended unconfirmed with a flagged calendar event, oldest first. */
export async function abandonedEventHolds(q: Queryable, limit = 50): Promise<Booking[]> {
  const { rows } = await q.query(
    "SELECT * FROM booking WHERE event_cleanup_pending AND status = 'expired' ORDER BY updated_at LIMIT $1",
    [limit],
  );
  return rows.map((r) => rowToBooking(r as BookingRow));
}

export async function clearEventCleanup(q: Queryable, id: string): Promise<void> {
  await q.query("UPDATE booking SET event_cleanup_pending = false WHERE id = $1", [id]);
}

/** Release a still-held booking (frees the seat). Used on unrecoverable calendar failure. */
export async function releaseHeld(q: Queryable, id: string): Promise<void> {
  await q.query(
    "UPDATE booking SET status = 'expired', expires_at = NULL, updated_at = now() WHERE id = $1 AND status = 'held'",
    [id],
  );
}

/**
 * Sweep: expire all holds past their TTL. Returns the ids actually flipped by THIS
 * statement (RETURNING), so the caller audits exactly those — never a hold that a
 * concurrent lazy reclaim already expired and audited (T234).
 */
export async function expireDueHolds(q: Queryable, now: Date): Promise<string[]> {
  const { rows } = await q.query(
    "UPDATE booking SET status = 'expired', expires_at = NULL, updated_at = now() WHERE status = 'held' AND expires_at <= $1 RETURNING id",
    [now],
  );
  return rows.map((r) => r.id as string);
}

/** True when one of `ids` is a hold still alive (a booking in progress in this conversation, 007). */
export async function hasLiveHold(q: Queryable, ids: string[], now: Date): Promise<boolean> {
  if (ids.length === 0) return false;
  const { rows } = await q.query(
    "SELECT 1 FROM booking WHERE id::text = ANY($1::text[]) AND status = 'held' AND expires_at > $2 LIMIT 1",
    [ids, now],
  );
  return rows.length > 0;
}

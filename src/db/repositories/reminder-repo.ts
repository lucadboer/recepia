import type { Booking } from "../../domain/types";
import type { Pool, PoolClient } from "../pool";
import { rowToBooking } from "./booking-repo";

type Queryable = Pool | PoolClient;

// 007 appointment-reminders. Both claims lock the rows they return (FOR UPDATE SKIP LOCKED) so two
// job runs never pick the same booking; the stamp written in the same transaction is what makes a
// re-run skip it.

/** Latest consent row of the booking's patient is an opt-in (LGPD: reminders only with consent). */
const OPTED_IN = `(SELECT c.state FROM patient_consent c WHERE c.phone = b.patient_phone
                   ORDER BY c.seq DESC LIMIT 1) = 'opted_in'`;

/**
 * Clinic-confirmed, not yet reminded, starting in (now + noticeLead, now + lead], booked at least
 * `lead` before its start, patient currently opted in.
 */
export async function claimDueReminders(
  client: PoolClient,
  now: Date,
  leadMs: number,
  noticeLeadMs: number,
  limit: number,
): Promise<Booking[]> {
  const { rows } = await client.query(
    `SELECT b.* FROM booking b
     WHERE b.status = 'confirmed' AND b.reminder_sent_at IS NULL
       AND b.start_ts > $1 AND b.start_ts <= $2
       AND b.created_at <= b.start_ts - ($3::bigint * interval '1 millisecond')
       AND ${OPTED_IN}
     ORDER BY b.start_ts
     LIMIT $4
     FOR UPDATE OF b SKIP LOCKED`,
    [new Date(now.getTime() + noticeLeadMs), new Date(now.getTime() + leadMs), leadMs, limit],
  );
  return rows.map(rowToBooking);
}

export async function markReminderSent(client: PoolClient, id: string, now: Date): Promise<void> {
  await client.query("UPDATE booking SET reminder_sent_at = $2, updated_at = now() WHERE id = $1", [
    id,
    now,
  ]);
}

/** The booking's reminder actually reached the patient (007 review: queued is not received). */
const DELIVERED = `EXISTS (SELECT 1 FROM outbox_message r
                   WHERE r.dedupe_key = 'appointment_reminder:' || b.id::text AND r.status = 'sent')`;

/**
 * Reminded (and delivered), still only clinic-confirmed, not yet noticed, starting in
 * (now, now + noticeLead].
 */
export async function claimUnconfirmed(
  client: PoolClient,
  now: Date,
  noticeLeadMs: number,
  limit: number,
): Promise<Booking[]> {
  const { rows } = await client.query(
    `SELECT b.* FROM booking b
     WHERE b.status = 'confirmed' AND b.reminder_sent_at IS NOT NULL
       AND b.unconfirmed_notice_at IS NULL
       AND b.start_ts > $1 AND b.start_ts <= $2
       AND ${DELIVERED}
     ORDER BY b.start_ts
     LIMIT $3
     FOR UPDATE OF b SKIP LOCKED`,
    [now, new Date(now.getTime() + noticeLeadMs), limit],
  );
  return rows.map(rowToBooking);
}

export async function markUnconfirmedNoticed(
  client: PoolClient,
  id: string,
  now: Date,
): Promise<void> {
  await client.query(
    "UPDATE booking SET unconfirmed_notice_at = $2, updated_at = now() WHERE id = $1",
    [id, now],
  );
}

/**
 * The patient's upcoming bookings whose reminder was DELIVERED and that still await an answer — a
 * reminder still queued (or failed) is not one the patient can be answering (007 review).
 */
export async function pendingRemindersForPhone(
  q: Queryable,
  phone: string,
  now: Date,
): Promise<Booking[]> {
  const { rows } = await q.query(
    `SELECT b.* FROM booking b
     WHERE b.patient_phone = $1 AND b.status = 'confirmed' AND b.reminder_sent_at IS NOT NULL
       AND b.start_ts > $2 AND ${DELIVERED}
     ORDER BY b.start_ts`,
    [phone, now],
  );
  return rows.map(rowToBooking);
}

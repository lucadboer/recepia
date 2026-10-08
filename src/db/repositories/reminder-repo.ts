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

/** Reminded, still only clinic-confirmed, not yet noticed, starting in (now, now + noticeLead]. */
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

/** The patient's upcoming bookings whose reminder went out and that still await an answer. */
export async function pendingRemindersForPhone(
  q: Queryable,
  phone: string,
  now: Date,
): Promise<Booking[]> {
  const { rows } = await q.query(
    `SELECT * FROM booking
     WHERE patient_phone = $1 AND status = 'confirmed' AND reminder_sent_at IS NOT NULL
       AND start_ts > $2
     ORDER BY start_ts`,
    [phone, now],
  );
  return rows.map(rowToBooking);
}

/**
 * A booking released by a cancel or a reschedule must not be reminded: cancel its still-pending
 * reminder in the caller's transaction. Returns the cancelled outbox ids (for the audit trail).
 */
export async function cancelQueuedReminder(q: Queryable, bookingId: string): Promise<string[]> {
  const { rows } = await q.query(
    `UPDATE outbox_message SET status = 'cancelled', last_error = 'cancelled: booking released'
     WHERE dedupe_key = $1 AND status = 'pending'
     RETURNING id`,
    [`appointment_reminder:${bookingId}`],
  );
  return rows.map((r) => r.id as string);
}

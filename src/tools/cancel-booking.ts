import { appendAudit } from "../db/repositories/audit-repo";
import { cancelActive, lockBookingForUpdate } from "../db/repositories/booking-repo";
import {
  enqueueOutbox,
  messageStatus,
  releasedBookingMessages,
  supersedePending,
} from "../db/repositories/outbox-repo";
import type { Deps } from "../deps";
import { BookingNotChangeableError, BookingNotFoundError } from "../domain/errors";
import type { Booking } from "../domain/types";
import { cancellationMessagePt } from "../messages";
import { deleteEventWithRetry } from "./booking-calendar";
import { enqueueLateChangeNotice, isLateChange, requestCalendarCleanup } from "./reception-notices";

export type CancelOutcome = "cancelled" | "already_cancelled";

export interface CancelResult {
  booking: Booking;
  /**
   * `cancelled` = the patient's cancellation message is owned by the outbox as a result of this
   * call, or is still pending from an identical earlier call (so the caller adds no reply of its
   * own); `already_cancelled` = it was cancelled before and the message already left.
   */
  outcome: CancelOutcome;
  /** Less than 24h before the appointment: reception was notified too (FR-606). */
  late: boolean;
}

const ACTIVE = new Set(["confirmed", "patient_confirmed"]);

/**
 * Cancel the patient's booking (006 FR-604). Database first — one transaction locks the row,
 * cancels it (its seat is free at once), supersedes its still-pending confirmation, commits the
 * patient's message (and reception's notice when late) and audits; then the calendar event is
 * removed. Postgres owns capacity: an event that cannot be removed never undoes the cancel, it
 * becomes a reception notice. A repeated call finishes that removal (a lost COMMIT acknowledgment
 * must not leave the event behind) and writes nothing else. Another phone's booking is
 * indistinguishable from an unknown id (BookingNotFoundError).
 */
export async function cancelBooking(
  deps: Deps,
  bookingId: string,
  phone: string,
): Promise<CancelResult> {
  const now = deps.clock.now();
  const client = await deps.pool.connect();
  let booking: Booking;
  let fresh = false;
  let late = false;
  try {
    await client.query("BEGIN");
    const row = await lockBookingForUpdate(client, bookingId);
    if (!row || row.patientPhone !== phone) {
      await client.query("ROLLBACK");
      throw new BookingNotFoundError();
    }
    if (row.status === "cancelled") {
      await client.query("ROLLBACK");
      booking = row; // repeated call: only the calendar removal is (re)done below
    } else {
      if (!ACTIVE.has(row.status) || row.start.getTime() <= now.getTime()) {
        await client.query("ROLLBACK");
        throw new BookingNotChangeableError();
      }
      const flipped = await cancelActive(client, row.id, now);
      if (!flipped) throw new BookingNotChangeableError(); // unreachable under the row lock
      late = isLateChange(row.start, now);
      // The original confirmation, a queued reminder or attendance reply must never reach the
      // patient after the cancellation (006 review, 007 FR-702).
      await supersedePending(client, releasedBookingMessages(row.id));
      const outboxId = await enqueueOutbox(client, {
        kind: "booking_cancellation",
        toPhone: phone,
        conversationPhone: phone,
        body: cancellationMessagePt(row.appointmentType, row.start),
        dedupeKey: `booking_cancellation:${row.id}`,
        now,
      });
      if (late) {
        await enqueueLateChangeNotice(client, deps, {
          bookingId: row.id,
          change: "cancelled",
          phone,
          name: row.patientName,
          type: row.appointmentType,
          start: row.start,
          now,
        });
      }
      await appendAudit(client, {
        entity: "booking",
        entityId: row.id,
        action: "booking_cancelled",
        actor: "ai",
        payload: {
          reason: "patient",
          start: row.start.toISOString(),
          late,
          outboxId,
          ...(deps.promptVersion ? { promptVersion: deps.promptVersion } : {}),
        },
      });
      await client.query("COMMIT");
      booking = flipped;
      fresh = true;
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  await removeEvent(deps, booking, phone, now);
  if (fresh) return { booking, outcome: "cancelled", late };
  // Replay: while the cancellation message is still queued, the outbox owns the reply (as in
  // confirm and reschedule) — the caller must not add a second message.
  const queued = await messageStatus(deps.pool, `booking_cancellation:${booking.id}`);
  return {
    booking,
    outcome: queued === "pending" ? "cancelled" : "already_cancelled",
    late: false,
  };
}

/** Remove the cancelled booking's event; one that keeps failing becomes a reception notice. */
async function removeEvent(deps: Deps, booking: Booking, phone: string, now: Date): Promise<void> {
  if (await deleteEventWithRetry(deps, booking.id)) return;
  await requestCalendarCleanup(deps, {
    bookingId: booking.id,
    phone,
    start: booking.start,
    eventId: booking.googleEventId,
    now,
  });
}

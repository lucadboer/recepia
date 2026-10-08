import { appendAudit } from "../db/repositories/audit-repo";
import { cancelActive, lockBookingForUpdate } from "../db/repositories/booking-repo";
import { enqueueOutbox } from "../db/repositories/outbox-repo";
import { cancelQueuedReminder } from "../db/repositories/reminder-repo";
import type { Deps } from "../deps";
import { BookingNotChangeableError, BookingNotFoundError } from "../domain/errors";
import type { Booking } from "../domain/types";
import { cancellationMessagePt } from "../messages";
import { deleteEventWithRetry } from "./booking-calendar";
import { enqueueLateChangeNotice, isLateChange, requestCalendarCleanup } from "./reception-notices";

export type CancelOutcome = "cancelled" | "already_cancelled";

export interface CancelResult {
  booking: Booking;
  outcome: CancelOutcome;
  /** Less than 24h before the appointment: reception was notified too (FR-606). */
  late: boolean;
}

const ACTIVE = new Set(["confirmed", "patient_confirmed"]);

/**
 * Cancel the patient's booking (006 FR-604). Database first — one transaction locks the row,
 * cancels it (its seat is free at once), commits the patient's message (and reception's notice
 * when late) and audits; then the calendar event is removed. Postgres owns capacity: an event
 * that cannot be removed never undoes the cancel, it becomes a reception notice.
 * Another phone's booking is indistinguishable from an unknown id (BookingNotFoundError).
 */
export async function cancelBooking(
  deps: Deps,
  bookingId: string,
  phone: string,
): Promise<CancelResult> {
  const now = deps.clock.now();
  const client = await deps.pool.connect();
  let cancelled: Booking;
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
      return { booking: row, outcome: "already_cancelled", late: false };
    }
    if (!ACTIVE.has(row.status) || row.start.getTime() <= now.getTime()) {
      await client.query("ROLLBACK");
      throw new BookingNotChangeableError();
    }
    const flipped = await cancelActive(client, row.id, now);
    if (!flipped) throw new BookingNotChangeableError(); // unreachable under the row lock
    late = isLateChange(row.start, now);
    // A released booking is never reminded (007 FR-702): drop a still-queued reminder.
    await cancelQueuedReminder(client, row.id);
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
    cancelled = flipped;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  if (!(await deleteEventWithRetry(deps, cancelled.id))) {
    await requestCalendarCleanup(deps, {
      bookingId: cancelled.id,
      phone,
      start: cancelled.start,
      eventId: cancelled.googleEventId,
      now,
    });
  }
  return { booking: cancelled, outcome: "cancelled", late };
}

import { appendAudit } from "../db/repositories/audit-repo.ts";
import {
  cancelActive,
  confirmHeld,
  getById,
  lockBookingForUpdate,
  releaseHeld,
} from "../db/repositories/booking-repo.ts";
import {
  confirmationStatus,
  enqueueOutbox,
  releasedBookingMessages,
  supersedePending,
} from "../db/repositories/outbox-repo.ts";
import { type Deps, turnStamp } from "../deps.ts";
import { isExpired } from "../domain/booking.ts";
import {
  BookingNotChangeableError,
  BookingNotFoundError,
  CalendarWriteError,
  flagEscalated,
  HoldExpiredError,
  InvalidRescheduleError,
} from "../domain/errors.ts";
import type { Booking } from "../domain/types.ts";
import { rescheduledMessagePt } from "../messages.ts";
import { deleteEventWithRetry, writeEventWithRetry } from "./booking-calendar.ts";
import { escalateToHuman } from "./escalate-to-human.ts";
import {
  enqueueLateChangeNotice,
  isLateChange,
  requestCalendarCleanup,
} from "./reception-notices.ts";

export type RescheduleOutcome = "rescheduled" | "already_rescheduled";

export interface RescheduleResult {
  /** The new booking (the confirmed hold). */
  booking: Booking;
  /** The booking it replaced (now cancelled). */
  previous: Booking;
  /**
   * `rescheduled` = the patient's message is owned by the outbox as a result of this call (or is
   * still pending from an identical earlier call); `already_rescheduled` = it already left.
   */
  outcome: RescheduleOutcome;
  /** Less than 24h before the ORIGINAL appointment: reception was notified too (FR-606). */
  late: boolean;
}

const ACTIVE = new Set(["confirmed", "patient_confirmed"]);

/**
 * Move the patient's booking to a time they already hold (006 FR-605). The hold came from the
 * normal get_availability → hold_slot path, so capacity, the per-slot lock and the booking
 * window were enforced there; this tool never allocates a seat itself.
 *
 *  1. Validate (own, active, upcoming booking; own, live hold of the same type at another time).
 *  2. Write the new calendar event first (idempotent by the new booking id). Failure → release
 *     the hold, hand off; the old booking is untouched.
 *  3. One transaction: lock the old row, confirm the hold linked to it (`rescheduled_from`, unique
 *     → at most one reschedule ever wins), cancel the old row, commit the patient's message (+
 *     reception's when late) and audit both rows.
 *  4. Then remove the old event; an event that cannot be removed becomes a reception notice.
 * If step 3 cannot commit, an identical earlier success is returned; otherwise the new event is
 * compensated, the hold released, and the conversation handed off — the old booking stands.
 */
export async function rescheduleBooking(
  deps: Deps,
  bookingId: string,
  holdId: string,
  phone: string,
): Promise<RescheduleResult> {
  const now = deps.clock.now();

  const old = await getById(deps.pool, bookingId);
  if (!old || old.patientPhone !== phone) throw new BookingNotFoundError();
  const hold = await getById(deps.pool, holdId);
  if (!hold || hold.patientPhone !== phone) throw new HoldExpiredError("Reserva não encontrada.");

  if (ACTIVE.has(hold.status) && hold.rescheduledFrom === old.id) {
    // Idempotent repeat: finish the old event's removal (a lost COMMIT acknowledgment must not
    // leave it behind — review), and while the message is still queued the outbox owns it.
    await removeOldEvent(deps, old, phone, now);
    const queued = await confirmationStatus(deps.pool, hold.id);
    const outcome = queued === "pending" ? "rescheduled" : "already_rescheduled";
    return { booking: hold, previous: old, outcome, late: false };
  }
  if (!ACTIVE.has(old.status) || old.start.getTime() <= now.getTime()) {
    throw new BookingNotChangeableError();
  }
  if (hold.status !== "held" || isExpired(hold.expiresAt, now)) throw new HoldExpiredError();
  if (hold.appointmentType !== old.appointmentType) {
    throw new InvalidRescheduleError("different_type");
  }
  if (hold.start.getTime() === old.start.getTime()) throw new InvalidRescheduleError("same_time");

  const name = old.patientName ?? "Paciente";
  const eventId = await writeEventWithRetry(deps, hold, { name, phone });
  if (eventId === null) {
    await releaseHold(deps, hold.id, "calendar_write_failed");
    await escalateToHuman(deps, {
      reason: "calendar_write_failed",
      phone,
      context: `Falha ao gravar o evento da remarcação ${old.id} → ${hold.id}; consulta original mantida.`,
    });
    throw flagEscalated(new CalendarWriteError());
  }

  const late = isLateChange(old.start, now);
  const client = await deps.pool.connect();
  let swapped: Booking | null = null;
  let cancelled: Booking | null = null;
  let failure: unknown = null;
  try {
    await client.query("BEGIN");
    const locked = await lockBookingForUpdate(client, old.id);
    // Deadlines are re-checked with the clock at commit time: the calendar call and the row-lock
    // wait can outlast the hold's TTL or the appointment's start (review).
    const txNow = deps.clock.now();
    const stillActive =
      locked !== null && ACTIVE.has(locked.status) && locked.start.getTime() > txNow.getTime();
    const confirmed = stillActive
      ? await confirmHeld(client, hold.id, name, eventId, now, old.id, txNow)
      : null;
    const released = confirmed ? await cancelActive(client, old.id, now) : null;
    if (confirmed && released) {
      // The original time's confirmation or reminder must never be delivered after the move
      // (006 review, 007 FR-702).
      await supersedePending(client, releasedBookingMessages(old.id));
      const outboxId = await enqueueOutbox(client, {
        kind: "booking_confirmation",
        toPhone: phone,
        conversationPhone: phone,
        body: rescheduledMessagePt(old.appointmentType, old.start, confirmed.start),
        dedupeKey: `booking_confirmation:${confirmed.id}`,
        now,
      });
      if (late) {
        await enqueueLateChangeNotice(client, deps, {
          bookingId: old.id,
          change: "rescheduled",
          phone,
          name: old.patientName,
          type: old.appointmentType,
          start: old.start,
          newStart: confirmed.start,
          now,
        });
      }
      const prompt = turnStamp(deps);
      await appendAudit(client, {
        entity: "booking",
        entityId: confirmed.id,
        action: "booking_rescheduled",
        actor: "ai",
        payload: {
          from: old.id,
          fromStart: old.start.toISOString(),
          start: confirmed.start.toISOString(),
          eventId,
          late,
          outboxId,
          ...prompt,
        },
      });
      await appendAudit(client, {
        entity: "booking",
        entityId: old.id,
        action: "booking_cancelled",
        actor: "ai",
        payload: {
          reason: "rescheduled",
          start: old.start.toISOString(),
          late,
          replacedBy: confirmed.id,
          ...prompt,
        },
      });
      await client.query("COMMIT");
      swapped = confirmed; // only once the COMMIT has actually succeeded (as in confirm, T232)
      cancelled = released;
    } else {
      await client.query("ROLLBACK");
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    failure = err;
  } finally {
    client.release();
  }

  if (swapped && cancelled) {
    await removeOldEvent(deps, cancelled, phone, now);
    return { booking: swapped, previous: cancelled, outcome: "rescheduled", late };
  }

  // Not committed by us. The event belongs to whichever active booking now holds it: never
  // compensate a confirmed booking's event (review: a concurrent confirm of the same hold).
  const current = await getById(deps.pool, hold.id);
  if (current && ACTIVE.has(current.status) && current.googleEventId === eventId) {
    if (current.rescheduledFrom === old.id) {
      // Our commit landed with a lost acknowledgment: the swap is real.
      const previous = (await getById(deps.pool, old.id)) ?? old;
      await removeOldEvent(deps, previous, phone, now);
      return { booking: current, previous, outcome: "rescheduled", late };
    }
    // Another operation confirmed this time as a booking of its own: keep its event, keep the
    // original appointment, and let reception sort out the two bookings.
    await escalateToHuman(deps, {
      reason: "reschedule_conflict",
      phone,
      context: `Remarcação ${old.id} → ${hold.id} não concluída: o novo horário foi confirmado por outra operação e a consulta original continua marcada. Verifique as duas consultas.`,
    });
    throw flagEscalated(new BookingNotChangeableError("A remarcação não pôde ser concluída."));
  }

  // True orphan: the new event has no booking. Compensate, release the hold, hand off.
  const deleted = await deleteEventWithRetry(deps, hold.id);
  await releaseHold(deps, hold.id, "reschedule_not_committed");
  const reason = failure ? "commit_failed" : "booking_or_hold_changed";
  await auditOrphan(deps, hold.id, eventId, reason, deleted);
  if (!deleted) {
    // Never claim a compensation that did not happen (review): reception removes it by hand.
    await requestCalendarCleanup(deps, {
      bookingId: hold.id,
      phone,
      start: hold.start,
      eventId,
      now,
    });
  }
  await escalateToHuman(deps, {
    reason: "calendar_orphan",
    phone,
    context: `Remarcação ${old.id} → ${hold.id} não concluída (${reason}); ${
      deleted
        ? "evento novo removido por compensação"
        : "o evento novo não pôde ser removido e a recepção recebeu um aviso para apagá-lo"
    }. A consulta original continua marcada.`,
  });
  throw flagEscalated(failure instanceof Error ? failure : new HoldExpiredError());
}

async function removeOldEvent(deps: Deps, old: Booking, phone: string, now: Date): Promise<void> {
  if (await deleteEventWithRetry(deps, old.id)) return;
  await requestCalendarCleanup(deps, {
    bookingId: old.id,
    phone,
    start: old.start,
    eventId: old.googleEventId,
    now,
  });
}

async function releaseHold(deps: Deps, holdId: string, reason: string): Promise<void> {
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    const { rowCount } = await client.query(
      "SELECT 1 FROM booking WHERE id = $1 AND status = 'held'",
      [holdId],
    );
    if (rowCount) {
      await releaseHeld(client, holdId);
      await appendAudit(client, {
        entity: "booking",
        entityId: holdId,
        action: "hold_released",
        actor: "system",
        payload: { reason },
      });
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function auditOrphan(
  deps: Deps,
  holdId: string,
  eventId: string,
  reason: string,
  deleted: boolean,
): Promise<void> {
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    await appendAudit(client, {
      entity: "booking",
      entityId: holdId,
      action: "calendar_orphan_compensated",
      actor: "system",
      payload: { eventId, reason, deleted },
    });
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK").catch(() => {});
  } finally {
    client.release();
  }
}

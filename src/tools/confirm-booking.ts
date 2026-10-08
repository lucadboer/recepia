import { appendAudit } from "../db/repositories/audit-repo";
import { confirmHeld, getById, releaseHeld } from "../db/repositories/booking-repo";
import { confirmationStatus, enqueueOutbox } from "../db/repositories/outbox-repo";
import { type Deps, turnStamp } from "../deps";
import { isExpired } from "../domain/booking";
import { CalendarWriteError, flagEscalated, HoldExpiredError } from "../domain/errors";
import type { Booking, Patient } from "../domain/types";
import { confirmationMessagePt } from "../messages";
import { deleteEventWithRetry, writeEventWithRetry } from "./booking-calendar";
import { escalateToHuman } from "./escalate-to-human";
import { requestCalendarCleanup } from "./reception-notices";

const CONFIRMED_STATUSES = new Set(["confirmed", "patient_confirmed", "done"]);

export type ConfirmOutcome = "confirmed" | "already_confirmed";

export interface ConfirmResult {
  booking: Booking;
  /**
   * `confirmed` = the patient's confirmation is owned by the outbox as a result of this call:
   * this call enqueued it, or it is still pending delivery, or this call's COMMIT landed but its
   * acknowledgment was lost (the row exists). The orchestrator then sends no closing text.
   * `already_confirmed` = the booking was confirmed earlier and its confirmation already left.
   */
  outcome: ConfirmOutcome;
}

/**
 * Commit a held slot: write exactly one calendar event, flip to confirmed, and enqueue
 * the patient's confirmation in the SAME transaction (transactional outbox, FR-214) —
 * delivery with retries happens in jobs/dispatch-outbox.ts. On persistent calendar
 * failure: retry briefly, then escalate + release the hold — never confirm without a
 * written event (FR-021).
 *
 * If the event is written but the hold can no longer be confirmed (swept/expired
 * concurrently, or the DB commit fails), the event is compensated (deleted),
 * audited, and escalated — never silently orphaned. A concurrent confirm that
 * already won is returned idempotently (its event is kept). The confirmed booking is
 * only assigned AFTER the COMMIT resolves (T232), so a failed commit never yields a
 * confirmed result or a queued message.
 */
export async function confirmBooking(
  deps: Deps,
  holdId: string,
  patient: Patient,
): Promise<ConfirmResult> {
  const now = deps.clock.now();

  const existing = await getById(deps.pool, holdId);
  if (!existing) throw new HoldExpiredError("Reserva não encontrada.");
  if (CONFIRMED_STATUSES.has(existing.status)) {
    // Idempotent re-confirm. If the confirmation from the earlier call is still queued, the
    // outbox still owns the patient message (it goes out with this turn's flush).
    const queued = await confirmationStatus(deps.pool, existing.id);
    return { booking: existing, outcome: queued === "pending" ? "confirmed" : "already_confirmed" };
  }
  if (existing.status !== "held" || isExpired(existing.expiresAt, now)) {
    throw new HoldExpiredError();
  }

  // Calendar write with short retry, outside any DB transaction.
  const eventId = await writeEventWithRetry(deps, existing, patient);

  if (eventId === null) {
    const client = await deps.pool.connect();
    try {
      await client.query("BEGIN");
      await releaseHeld(client, existing.id);
      await appendAudit(client, {
        entity: "booking",
        entityId: existing.id,
        action: "hold_released",
        actor: "system",
        payload: { reason: "calendar_write_failed" },
      });
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    await escalateToHuman(deps, {
      reason: "calendar_write_failed",
      phone: patient.phone,
      context: `Falha ao gravar o evento da reserva ${existing.id}.`,
    });
    throw flagEscalated(new CalendarWriteError()); // reception already notified above
  }

  // Event written. Persist the confirmation + its outbox message atomically; compensate
  // if it can't be confirmed.
  const client = await deps.pool.connect();
  let confirmed: Booking | null = null;
  let commitError: unknown = null;
  try {
    await client.query("BEGIN");
    // The hold's TTL is re-checked with the clock at commit time: the calendar call may have
    // outlasted it even if no sweep has expired the row yet (006 review).
    const flipped = await confirmHeld(
      client,
      existing.id,
      patient.name,
      eventId,
      now,
      null,
      deps.clock.now(),
    );
    if (flipped) {
      const outboxId = await enqueueOutbox(client, {
        kind: "booking_confirmation",
        toPhone: patient.phone,
        conversationPhone: patient.phone,
        body: confirmationMessagePt(flipped.appointmentType, flipped.start),
        dedupeKey: `booking_confirmation:${flipped.id}`,
        now,
      });
      await appendAudit(client, {
        entity: "booking",
        entityId: flipped.id,
        action: "booking_confirmed",
        actor: "ai",
        payload: {
          eventId,
          start: flipped.start.toISOString(),
          outboxId,
          ...turnStamp(deps),
        },
      });
      await client.query("COMMIT");
      confirmed = flipped; // only once the COMMIT has actually succeeded (T232)
    } else {
      await client.query("ROLLBACK");
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    commitError = err;
  } finally {
    client.release();
  }

  if (confirmed) return { booking: confirmed, outcome: "confirmed" };

  // Either a concurrent confirm won, or OUR commit landed but its acknowledgment was lost
  // (commitError set, row confirmed with our event). In both cases the event must be kept,
  // and if a confirmation row exists the outbox owns the patient message — never let the
  // caller add a second one (T227).
  const current = await getById(deps.pool, existing.id);
  if (current && CONFIRMED_STATUSES.has(current.status) && current.googleEventId === eventId) {
    const queued = await confirmationStatus(deps.pool, existing.id);
    const owned = queued !== null && queued !== "cancelled";
    return { booking: current, outcome: owned ? "confirmed" : "already_confirmed" };
  }

  // True orphan: an event exists with no booking. Delete it, audit, escalate.
  const deleted = await deleteEventWithRetry(deps, existing.id);
  const reason = commitError ? "commit_failed" : "hold_not_held";
  if (!deleted) {
    // Never claim a compensation that did not happen (006 review): reception removes it by hand.
    await requestCalendarCleanup(deps, {
      bookingId: existing.id,
      phone: patient.phone,
      start: existing.start,
      eventId,
      now,
    });
  }
  const orphanClient = await deps.pool.connect();
  try {
    await orphanClient.query("BEGIN");
    await appendAudit(orphanClient, {
      entity: "booking",
      entityId: existing.id,
      action: "calendar_orphan_compensated",
      actor: "system",
      payload: { eventId, reason, deleted },
    });
    await orphanClient.query("COMMIT");
  } catch {
    await orphanClient.query("ROLLBACK").catch(() => {});
  } finally {
    orphanClient.release();
  }
  await escalateToHuman(deps, {
    reason: "calendar_orphan",
    phone: patient.phone,
    context: `Evento da reserva ${existing.id} foi criado mas a confirmação falhou (${reason}); ${
      deleted
        ? "evento removido por compensação"
        : "o evento não pôde ser removido e a recepção recebeu um aviso para apagá-lo"
    }.`,
  });
  throw flagEscalated(commitError instanceof Error ? commitError : new HoldExpiredError());
}

import { CALENDAR_MAX_ATTEMPTS, CALENDAR_RETRY_BASE_MS } from "../config";
import { appendAudit } from "../db/repositories/audit-repo";
import { confirmHeld, getById, releaseHeld } from "../db/repositories/booking-repo";
import { confirmationStatus, enqueueOutbox } from "../db/repositories/outbox-repo";
import type { Deps } from "../deps";
import { isExpired } from "../domain/booking";
import { CalendarWriteError, HoldExpiredError } from "../domain/errors";
import type { Booking, Patient } from "../domain/types";
import { confirmationMessagePt } from "../messages";
import { escalateToHuman } from "./escalate-to-human";

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  let eventId: string | null = null;
  for (let attempt = 1; attempt <= CALENDAR_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await deps.calendar.createEvent({
        idempotencyKey: existing.id,
        start: existing.start,
        end: existing.end,
        title: `Consulta de rotina (${existing.appointmentType})`,
        patientName: patient.name,
        patientPhone: patient.phone,
      });
      eventId = res.eventId;
      break;
    } catch {
      if (attempt < CALENDAR_MAX_ATTEMPTS) await sleep(CALENDAR_RETRY_BASE_MS * attempt);
    }
  }

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
    throw new CalendarWriteError();
  }

  // Event written. Persist the confirmation + its outbox message atomically; compensate
  // if it can't be confirmed.
  const client = await deps.pool.connect();
  let confirmed: Booking | null = null;
  let commitError: unknown = null;
  try {
    await client.query("BEGIN");
    const flipped = await confirmHeld(client, existing.id, patient.name, eventId, now);
    if (flipped) {
      const outboxId = await enqueueOutbox(client, {
        kind: "booking_confirmation",
        toPhone: patient.phone,
        body: confirmationMessagePt(flipped.appointmentType, flipped.start),
        dedupeKey: `booking_confirmation:${flipped.id}`,
        now,
      });
      await appendAudit(client, {
        entity: "booking",
        entityId: flipped.id,
        action: "booking_confirmed",
        actor: "ai",
        payload: { eventId, start: flipped.start.toISOString(), outboxId },
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
    return { booking: current, outcome: queued ? "confirmed" : "already_confirmed" };
  }

  // True orphan: an event exists with no booking. Delete it, audit, escalate.
  await deps.calendar.deleteEvent(existing.id).catch(() => {});
  const reason = commitError ? "commit_failed" : "hold_not_held";
  const orphanClient = await deps.pool.connect();
  try {
    await orphanClient.query("BEGIN");
    await appendAudit(orphanClient, {
      entity: "booking",
      entityId: existing.id,
      action: "calendar_orphan_compensated",
      actor: "system",
      payload: { eventId, reason },
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
    context: `Evento da reserva ${existing.id} foi criado mas a confirmação falhou (${reason}); evento removido por compensação.`,
  });
  throw commitError instanceof Error ? commitError : new HoldExpiredError();
}

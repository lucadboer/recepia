import { CALENDAR_MAX_ATTEMPTS, CALENDAR_RETRY_BASE_MS } from "../config";
import { appendAudit } from "../db/repositories/audit-repo";
import { confirmHeld, getById, releaseHeld } from "../db/repositories/booking-repo";
import type { Deps } from "../deps";
import { isExpired } from "../domain/booking";
import { CalendarWriteError, HoldExpiredError } from "../domain/errors";
import type { Booking, Patient } from "../domain/types";
import { confirmationMessagePt } from "../messages";
import { escalateToHuman } from "./escalate-to-human";

const CONFIRMED_STATUSES = new Set(["confirmed", "patient_confirmed", "done"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Commit a held slot: write exactly one calendar event, flip to confirmed, and
 * send the patient a confirmation. On persistent calendar failure: retry briefly,
 * then escalate + release the hold — never confirm without a written event (FR-021).
 */
export async function confirmBooking(
  deps: Deps,
  holdId: string,
  patient: Patient,
): Promise<Booking> {
  const now = deps.clock.now();

  const existing = await getById(deps.pool, holdId);
  if (!existing) throw new HoldExpiredError("Reserva não encontrada.");
  if (CONFIRMED_STATUSES.has(existing.status)) return existing; // idempotent
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
    await escalateToHuman(
      deps,
      "calendar_write_failed",
      `Falha ao gravar o evento da reserva ${existing.id}.`,
    );
    throw new CalendarWriteError();
  }

  const client = await deps.pool.connect();
  let confirmed: Booking | null;
  try {
    await client.query("BEGIN");
    confirmed = await confirmHeld(client, existing.id, patient.name, eventId, now);
    if (!confirmed) {
      throw new HoldExpiredError(); // hold was swept/confirmed concurrently
    }
    await appendAudit(client, {
      entity: "booking",
      entityId: confirmed.id,
      action: "booking_confirmed",
      actor: "ai",
      payload: { eventId, start: confirmed.start.toISOString() },
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  await deps.messaging.sendMessage(
    patient.phone,
    confirmationMessagePt(confirmed.appointmentType, confirmed.start),
  );
  return confirmed;
}

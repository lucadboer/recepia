// Calendar writes shared by the booking tools (confirm, reschedule, cancel — 006): short retries
// outside any database transaction. Postgres owns capacity; the calendar may lag, never lead.

import { CALENDAR_MAX_ATTEMPTS, CALENDAR_RETRY_BASE_MS } from "../config";
import type { Deps } from "../deps";
import type { Booking } from "../domain/types";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create the booking's event (idempotent by booking id). Returns the event id, or null when
 * every attempt failed — the caller decides how to fail (release + escalate).
 */
export async function writeEventWithRetry(
  deps: Deps,
  booking: Pick<Booking, "id" | "start" | "end" | "appointmentType">,
  patient: { name: string; phone: string },
): Promise<string | null> {
  for (let attempt = 1; attempt <= CALENDAR_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await deps.calendar.createEvent({
        idempotencyKey: booking.id,
        start: booking.start,
        end: booking.end,
        title: `Consulta de rotina (${booking.appointmentType})`,
        patientName: patient.name,
        patientPhone: patient.phone,
      });
      return res.eventId;
    } catch {
      if (attempt < CALENDAR_MAX_ATTEMPTS) await sleep(CALENDAR_RETRY_BASE_MS * attempt);
    }
  }
  return null;
}

/** Delete the booking's event (already-gone counts as done). False when every attempt failed. */
export async function deleteEventWithRetry(deps: Deps, bookingId: string): Promise<boolean> {
  for (let attempt = 1; attempt <= CALENDAR_MAX_ATTEMPTS; attempt++) {
    try {
      await deps.calendar.deleteEvent(bookingId);
      return true;
    } catch {
      if (attempt < CALENDAR_MAX_ATTEMPTS) await sleep(CALENDAR_RETRY_BASE_MS * attempt);
    }
  }
  return false;
}

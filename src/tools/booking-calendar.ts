// Calendar writes shared by the booking tools (confirm, reschedule, cancel — 006): short retries
// outside any database transaction. Postgres owns capacity; the calendar may lag, never lead.

import { CALENDAR_MAX_ATTEMPTS, CALENDAR_RETRY_BASE_MS } from "../config";
import { flagEventCleanup } from "../db/repositories/booking-repo";
import type { Deps } from "../deps";
import { LeaseLostError } from "../domain/errors";
import type { Booking } from "../domain/types";
import { requestCalendarCleanup } from "./reception-notices";

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

/**
 * Remove a cancelled booking's event after the cancellation committed (cancel, reschedule, and a
 * replay that finishes either one, 008); one that keeps failing becomes a reception notice.
 * Idempotent: an event already gone counts as removed, and the notice is deduplicated.
 */
export async function removeEventOrNotify(
  deps: Deps,
  booking: Pick<Booking, "id" | "start" | "googleEventId">,
  phone: string,
  now: Date,
): Promise<void> {
  if (await deleteEventWithRetry(deps, booking.id)) return;
  await requestCalendarCleanup(deps, {
    bookingId: booking.id,
    phone,
    start: booking.start,
    eventId: booking.googleEventId,
    now,
  });
}

/**
 * Call before undoing anything after a failed commit (008 review). A turn that lost its inbound
 * message to another worker must leave the hold and its calendar event alone — the new holder may
 * confirm that same hold, with that same event (idempotent by hold id) — so it only flags the hold
 * (the hold sweep removes the event if the hold ends unconfirmed) and stops with LeaseLostError.
 */
export async function yieldIfLeaseLost(deps: Deps, holdId: string): Promise<void> {
  try {
    await deps.lease?.fence();
  } catch (err) {
    if (err instanceof LeaseLostError) await flagEventCleanup(deps.pool, holdId);
    throw err;
  }
}

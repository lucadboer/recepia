// Reception notices committed by the booking-lifecycle tools (006): a late change (FR-606) and a
// calendar event that could not be removed (FR-604). Both go through the outbox like every message.

import type { PoolClient } from "../db/pool";
import { appendAudit } from "../db/repositories/audit-repo";
import { enqueueOutbox } from "../db/repositories/outbox-repo";
import type { Deps } from "../deps";
import type { AppointmentType } from "../domain/types";
import { calendarCleanupNoticePt, lateChangeNoticePt } from "../messages";
import { log } from "../telemetry/logger";

/** A cancel or reschedule this close to the appointment also notifies reception (owner, 2026-10-08). */
export const LATE_CHANGE_MS = 24 * 60 * 60 * 1000;

export function isLateChange(start: Date, now: Date): boolean {
  return start.getTime() - now.getTime() < LATE_CHANGE_MS;
}

/** Enqueue the late-change notice inside the caller's transaction (deduped per original booking). */
export async function enqueueLateChangeNotice(
  client: PoolClient,
  deps: Deps,
  c: {
    bookingId: string;
    change: "cancelled" | "rescheduled";
    phone: string;
    name: string | null;
    type: AppointmentType;
    start: Date;
    newStart?: Date;
    now: Date;
  },
): Promise<string | null> {
  return enqueueOutbox(client, {
    kind: "reception_notice",
    toPhone: deps.receptionPhone,
    conversationPhone: c.phone,
    body: lateChangeNoticePt(c),
    dedupeKey: `late_change:${c.bookingId}`,
    now: c.now,
  });
}

/**
 * The booking is already cancelled in Postgres (the source of truth for capacity) but its
 * calendar event could not be removed: audit it and ask reception to remove it by hand. Its own
 * transaction, after the change committed; a failure here is logged, never undoes the change.
 */
export async function requestCalendarCleanup(
  deps: Deps,
  b: { bookingId: string; phone: string; start: Date; eventId: string | null; now: Date },
): Promise<void> {
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    const outboxId = await enqueueOutbox(client, {
      kind: "reception_notice",
      toPhone: deps.receptionPhone,
      conversationPhone: b.phone,
      body: calendarCleanupNoticePt({ phone: b.phone, start: b.start }),
      dedupeKey: `calendar_cleanup:${b.bookingId}`,
      now: b.now,
    });
    await appendAudit(client, {
      entity: "booking",
      entityId: b.bookingId,
      action: "calendar_delete_failed",
      actor: "system",
      payload: { eventId: b.eventId, outboxId },
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    log.error(
      { event: "calendar_cleanup.request_failed", bookingId: b.bookingId, err },
      "could not record a calendar cleanup request",
    );
  } finally {
    client.release();
  }
}

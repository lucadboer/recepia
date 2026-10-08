import { appendAudit } from "../db/repositories/audit-repo";
import { lockBookingForUpdate } from "../db/repositories/booking-repo";
import { enqueueOutbox } from "../db/repositories/outbox-repo";
import type { Deps } from "../deps";
import { BookingNotChangeableError, BookingNotFoundError } from "../domain/errors";
import type { Booking } from "../domain/types";
import { attendanceConfirmedMessagePt } from "../messages";

export type AttendanceOutcome = "confirmed" | "already_confirmed";

/**
 * The patient confirmed they will come (007 FR-703/704): clinic-confirmed → `patient_confirmed`,
 * one reply committed through the outbox and an audit entry, in one transaction. `via` tells the
 * deterministic fast path ("SIM") from a model tool call. Another phone's booking is
 * indistinguishable from an unknown id.
 */
export async function confirmAttendance(
  deps: Deps,
  bookingId: string,
  phone: string,
  via: "fast_path" | "model",
): Promise<{ booking: Booking; outcome: AttendanceOutcome }> {
  const now = deps.clock.now();
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    const row = await lockBookingForUpdate(client, bookingId);
    if (!row || row.patientPhone !== phone) {
      await client.query("ROLLBACK");
      throw new BookingNotFoundError();
    }
    if (row.status === "patient_confirmed") {
      await client.query("ROLLBACK");
      return { booking: row, outcome: "already_confirmed" };
    }
    if (row.status !== "confirmed" || row.start.getTime() <= now.getTime()) {
      await client.query("ROLLBACK");
      throw new BookingNotChangeableError();
    }
    const { rows } = await client.query(
      "UPDATE booking SET status = 'patient_confirmed', updated_at = now() WHERE id = $1 RETURNING *",
      [row.id],
    );
    const outboxId = await enqueueOutbox(client, {
      kind: "booking_confirmation",
      toPhone: phone,
      conversationPhone: phone,
      body: attendanceConfirmedMessagePt(row.appointmentType, row.start),
      dedupeKey: `attendance_confirmation:${row.id}`,
      now,
    });
    await appendAudit(client, {
      entity: "booking",
      entityId: row.id,
      action: "attendance_confirmed",
      actor: via === "model" ? "ai" : "system",
      payload: {
        via,
        start: row.start.toISOString(),
        outboxId,
        ...(via === "model" && deps.promptVersion ? { promptVersion: deps.promptVersion } : {}),
      },
    });
    await client.query("COMMIT");
    return { booking: { ...row, status: rows[0].status }, outcome: "confirmed" };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

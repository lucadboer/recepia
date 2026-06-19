import { HOLD_TTL_MS, isRoutineType, SLOT_MINUTES } from "../config";
import { appendAudit } from "../db/repositories/audit-repo";
import {
  findActiveHold,
  insertHold,
  occupiedSeats,
  reclaimExpiredHoldsForSlot,
} from "../db/repositories/booking-repo";
import { loadOverrides, loadRules } from "../db/repositories/capacity-repo";
import type { Deps } from "../deps";
import { toHold } from "../domain/booking";
import { capacityFor } from "../domain/capacity";
import { OutOfScopeError, SlotUnavailableError } from "../domain/errors";
import { addMinutes, toLocalParts } from "../domain/time";
import type { Hold, PatientRef } from "../domain/types";

export interface SlotRequest {
  start: Date;
  type: string;
}

function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === "23505" && (!constraint || e.constraint === constraint);
}

/**
 * Atomically reserve a slot using a seat model. The advisory lock is an
 * optimization that cuts contention; the no-overbooking GUARANTEE is structural:
 * the UNIQUE(start_ts, seat) partial index forbids two active bookings on one seat,
 * so even a writer that bypasses the lock cannot exceed capacity. Idempotent per
 * patient+slot. Expired holds are reclaimed lazily (no dependency on the sweeper).
 */
export async function holdSlot(deps: Deps, slot: SlotRequest, patient: PatientRef): Promise<Hold> {
  if (!isRoutineType(slot.type)) throw new OutOfScopeError(slot.type);

  const now = deps.clock.now();
  const start = slot.start;
  const end = addMinutes(start, SLOT_MINUTES);

  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [start.toISOString()]);

    // Lazy reclaim: free seats of holds whose TTL elapsed, and move them to the
    // terminal 'expired' state so reassigning the seat won't collide with the index.
    await reclaimExpiredHoldsForSlot(client, start, now);

    const existing = await findActiveHold(client, patient.phone, start, now);
    if (existing) {
      await client.query("COMMIT");
      return toHold(existing);
    }

    const dateStr = toLocalParts(start).dateStr;
    const rules = await loadRules(client);
    const overrides = await loadOverrides(client, dateStr, dateStr);
    const capacity = capacityFor(start, rules, overrides);

    const occupied = new Set(await occupiedSeats(client, start));
    let seat = -1;
    for (let s = 0; s < capacity; s++) {
      if (!occupied.has(s)) {
        seat = s;
        break;
      }
    }
    if (seat === -1) throw new SlotUnavailableError();

    const expiresAt = new Date(now.getTime() + HOLD_TTL_MS);
    const booking = await insertHold(client, {
      patientPhone: patient.phone,
      appointmentType: slot.type,
      start,
      end,
      expiresAt,
      seat,
    });
    await appendAudit(client, {
      entity: "booking",
      entityId: booking.id,
      action: "hold_created",
      actor: "ai",
      payload: { start: start.toISOString(), phone: patient.phone, type: slot.type, seat },
    });
    await client.query("COMMIT");
    return toHold(booking);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    // Structural backstop fired (e.g., the lock was bypassed/raced): map cleanly.
    if (isUniqueViolation(err, "booking_slot_seat_uq")) throw new SlotUnavailableError();
    if (isUniqueViolation(err, "booking_active_hold_uq")) {
      const existing = await findActiveHold(deps.pool, patient.phone, start, now);
      if (existing) return toHold(existing);
      throw new SlotUnavailableError();
    }
    throw err;
  } finally {
    client.release();
  }
}

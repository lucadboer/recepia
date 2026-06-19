import { HOLD_TTL_MS, isRoutineType, SLOT_MINUTES } from "../config";
import { appendAudit } from "../db/repositories/audit-repo";
import { countActiveForSlot, findActiveHold, insertHold } from "../db/repositories/booking-repo";
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

/**
 * Atomically reserve a slot. Per-slot advisory lock serializes contenders so the
 * recheck-then-insert can never overbook. Idempotent per patient+slot.
 */
export async function holdSlot(deps: Deps, slot: SlotRequest, patient: PatientRef): Promise<Hold> {
  if (!isRoutineType(slot.type)) throw new OutOfScopeError(slot.type);

  const now = deps.clock.now();
  const start = slot.start;
  const end = addMinutes(start, SLOT_MINUTES);

  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize everyone targeting this exact slot (lock auto-released on commit/rollback).
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [start.toISOString()]);

    const existing = await findActiveHold(client, patient.phone, start, now);
    if (existing) {
      await client.query("COMMIT");
      return toHold(existing);
    }

    const dateStr = toLocalParts(start).dateStr;
    const rules = await loadRules(client);
    const overrides = await loadOverrides(client, dateStr, dateStr);
    const capacity = capacityFor(start, rules, overrides);
    const used = await countActiveForSlot(client, start, now);
    if (used >= capacity) {
      throw new SlotUnavailableError();
    }

    const expiresAt = new Date(now.getTime() + HOLD_TTL_MS);
    const booking = await insertHold(client, {
      patientPhone: patient.phone,
      appointmentType: slot.type,
      start,
      end,
      expiresAt,
    });
    await appendAudit(client, {
      entity: "booking",
      entityId: booking.id,
      action: "hold_created",
      actor: "ai",
      payload: { start: start.toISOString(), phone: patient.phone, type: slot.type },
    });
    await client.query("COMMIT");
    return toHold(booking);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

import { appendAudit } from "../db/repositories/audit-repo.ts";
import {
  abandonedEventHolds,
  clearEventCleanup,
  expireDueHolds,
} from "../db/repositories/booking-repo.ts";
import type { Deps } from "../deps.ts";
import { removeEventOrNotify } from "../tools/booking-calendar.ts";

/**
 * Sweep: expire all holds past their TTL and audit each release (Constitution V).
 * Audits come from the UPDATE's RETURNING ids, so a hold reclaimed lazily by a
 * concurrent holdSlot (which audits it itself) is never audited twice (T234).
 * Returns the count expired by this sweep.
 */
export async function expireHolds(deps: Deps): Promise<number> {
  const now = deps.clock.now();
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    const expiredIds = await expireDueHolds(client, now);
    for (const id of expiredIds) {
      await appendAudit(client, {
        entity: "booking",
        entityId: id,
        action: "hold_expired",
        actor: "system",
        payload: { reason: "sweep" },
      });
    }
    await client.query("COMMIT");
    return expiredIds.length;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Remove the calendar events that turns which lost their inbound message left on holds that then
 * ended unconfirmed (008 review: such a turn leaves the hold and its event to the new holder and
 * only flags the hold). Idempotent; an event that cannot be removed becomes a reception cleanup
 * notice. Runs after each sweep. Returns how many holds were settled.
 */
export async function removeAbandonedEvents(deps: Deps): Promise<number> {
  const holds = await abandonedEventHolds(deps.pool);
  for (const hold of holds) {
    await removeEventOrNotify(deps, hold, hold.patientPhone, deps.clock.now());
    await clearEventCleanup(deps.pool, hold.id);
  }
  return holds.length;
}

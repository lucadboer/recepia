import { appendAudit } from "../db/repositories/audit-repo.ts";
import { expireDueHolds } from "../db/repositories/booking-repo.ts";
import type { Deps } from "../deps.ts";

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

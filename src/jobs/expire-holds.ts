import { appendAudit } from "../db/repositories/audit-repo";
import { expireDueHolds } from "../db/repositories/booking-repo";
import type { Deps } from "../deps";

/** Sweep: expire all holds past their TTL and audit each release. Returns the count expired. */
export async function expireHolds(deps: Deps): Promise<number> {
  const now = deps.clock.now();
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "SELECT id FROM booking WHERE status = 'held' AND expires_at <= $1",
      [now],
    );
    const expired = await expireDueHolds(client, now);
    for (const r of rows) {
      await appendAudit(client, {
        entity: "booking",
        entityId: r.id,
        action: "hold_expired",
        actor: "system",
        payload: {},
      });
    }
    await client.query("COMMIT");
    return expired;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

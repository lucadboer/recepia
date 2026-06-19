import { appendAudit } from "../db/repositories/audit-repo";
import type { Deps } from "../deps";
import { escalationMessagePt } from "../messages";

/**
 * Hand a request to reception and end the autonomous attempt.
 * Creates no booking/hold; notifies reception; writes an `escalated` audit row.
 */
export async function escalateToHuman(deps: Deps, reason: string, context: string): Promise<void> {
  await deps.messaging.sendMessage(deps.receptionPhone, escalationMessagePt(reason, context));

  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    await appendAudit(client, {
      entity: "escalation",
      entityId: null,
      action: "escalated",
      actor: "ai",
      payload: { reason, context },
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

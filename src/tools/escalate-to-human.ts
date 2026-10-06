import { appendAudit } from "../db/repositories/audit-repo";
import type { Deps } from "../deps";
import { escalationMessagePt } from "../messages";

/** What reception needs to pick the conversation up (FR-204). */
export interface Escalation {
  /** Stable machine reason, e.g. "urgency", "max_iterations", "calendar_write_failed". */
  reason: string;
  /** Patient phone so reception can call back. `null` only for patient-less system escalations. */
  phone: string | null;
  /** What triggered the hand-off: the raw patient text or an error detail. */
  context: string;
  /** Deterministic excerpt of the recent conversation (see `summarizeHistory`). Never LLM text. */
  summary?: string[];
}

/**
 * Hand a request to reception and end the autonomous attempt.
 * Creates no booking/hold; notifies reception; writes an `escalated` audit row.
 */
export async function escalateToHuman(deps: Deps, escalation: Escalation): Promise<void> {
  const summary = escalation.summary ?? [];
  await deps.messaging.sendMessage(
    deps.receptionPhone,
    escalationMessagePt({ ...escalation, summary }),
  );

  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    await appendAudit(client, {
      entity: "escalation",
      entityId: null,
      action: "escalated",
      actor: "ai",
      payload: {
        reason: escalation.reason,
        context: escalation.context,
        phone: escalation.phone,
        summary,
      },
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

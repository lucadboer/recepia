import { appendAudit } from "../db/repositories/audit-repo";
import { enqueueOutbox } from "../db/repositories/outbox-repo";
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
 * Hand a request to reception and end the autonomous attempt. Creates no booking/hold.
 * The reception notice is enqueued in the transactional outbox IN THE SAME TRANSACTION
 * as the `escalated` audit row (FR-214): either both exist or neither does. Delivery
 * (with retries and dead-letter) is the dispatcher's job — see jobs/dispatch-outbox.ts.
 */
export async function escalateToHuman(deps: Deps, escalation: Escalation): Promise<void> {
  const summary = escalation.summary ?? [];
  const now = deps.clock.now();

  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    const outboxId = await enqueueOutbox(client, {
      kind: "escalation",
      toPhone: deps.receptionPhone,
      body: escalationMessagePt({ ...escalation, summary }),
      now,
    });
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
        outboxId,
      },
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

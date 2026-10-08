import type { Pool, PoolClient } from "../pool";

export type AuditAction =
  | "hold_created"
  | "hold_expired"
  | "hold_released"
  | "booking_confirmed"
  | "calendar_orphan_compensated"
  | "escalated"
  | "consent_recorded"
  | "consent_revoked"
  | "outbox_dead_letter"
  | "outbox_cancelled"
  | "conversation_released"
  | "retention_purged"
  | "booking_cancelled"
  | "booking_rescheduled"
  | "calendar_delete_failed"
  | "reminder_enqueued"
  | "attendance_confirmed"
  | "unconfirmed_notified"
  | "inbound_dead_letter";

export interface AuditEntry {
  entity: string;
  entityId: string | null;
  action: AuditAction;
  actor: "ai" | "system" | "human";
  payload: unknown;
}

/** Append-only. Requires the client of the surrounding transaction (same-tx atomicity). */
export async function appendAudit(q: PoolClient, entry: AuditEntry): Promise<void> {
  await q.query(
    "INSERT INTO audit_log (entity, entity_id, action, actor, payload) VALUES ($1, $2, $3, $4, $5)",
    [
      entry.entity,
      entry.entityId,
      entry.action,
      entry.actor,
      JSON.stringify(entry.payload ?? null),
    ],
  );
}

/** Writes that end a turn's work: once one exists for a message, re-running it would duplicate it. */
const FINAL_ACTIONS = [
  "booking_confirmed",
  "booking_rescheduled",
  "booking_cancelled",
  "attendance_confirmed",
  "escalated",
] as const;

/**
 * True when the turn for this inbound message already committed a final write (008: a message is
 * reclaimed after a crash between the tools' commit and the conversation save).
 */
export async function messageAlreadyCommitted(
  q: PoolClient | Pool,
  inboundMessageId: string,
): Promise<boolean> {
  const { rows } = await q.query(
    `SELECT 1 FROM audit_log
     WHERE (payload->>'inboundMessageId') = $1 AND action = ANY($2::text[])
     LIMIT 1`,
    [inboundMessageId, FINAL_ACTIONS],
  );
  return rows.length > 0;
}

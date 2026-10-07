import type { PoolClient } from "../pool";

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
  | "retention_purged";

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

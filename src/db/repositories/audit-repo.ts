import type { Pool, PoolClient } from "../pool";

export type AuditAction =
  | "hold_created"
  | "hold_expired"
  | "hold_released"
  | "booking_confirmed"
  | "escalated";

export interface AuditEntry {
  entity: string;
  entityId: string | null;
  action: AuditAction;
  actor: "ai" | "system" | "human";
  payload: unknown;
}

/** Append-only. Pass the same client used by the surrounding transaction. */
export async function appendAudit(q: Pool | PoolClient, entry: AuditEntry): Promise<void> {
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

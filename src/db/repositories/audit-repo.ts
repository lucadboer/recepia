import type { Pool, PoolClient } from "../pool.ts";

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

export type FinalAction = (typeof FINAL_ACTIONS)[number];

/** A final write a turn committed for its inbound message (008 replay guard). */
export interface CommittedWrite {
  action: FinalAction;
  entityId: string | null;
}

/**
 * The final writes the turn for this inbound message already committed (008: a
 * message is reclaimed after a crash between the tools' commit and the conversation save). Empty
 * when the turn has not committed one. Served by the partial index of migration 013, whose
 * predicate the query repeats so the planner can use it.
 */
export async function committedTurnWrites(
  q: PoolClient | Pool,
  inboundMessageId: string,
): Promise<CommittedWrite[]> {
  const { rows } = await q.query(
    `SELECT action, entity_id FROM audit_log
     WHERE payload ? 'inboundMessageId'
       AND (payload->>'inboundMessageId') = $1
       AND action = ANY($2::text[])`,
    [inboundMessageId, FINAL_ACTIONS],
  );
  return rows.map((r) => ({
    action: r.action as FinalAction,
    entityId: (r.entity_id as string | null) ?? null,
  }));
}

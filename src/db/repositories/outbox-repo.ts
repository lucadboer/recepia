import type { Pool, PoolClient } from "../pool";

type Queryable = Pool | PoolClient;

export type OutboxKind = "booking_confirmation" | "escalation";

export interface OutboxRow {
  id: string;
  kind: OutboxKind;
  toPhone: string;
  body: string;
  attempts: number;
}

export interface EnqueueOutboxInput {
  kind: OutboxKind;
  toPhone: string;
  body: string;
  /** Optional idempotency key for the enqueue (e.g. `booking_confirmation:<bookingId>`). */
  dedupeKey?: string;
  /** When the first delivery attempt may happen (usually the caller's `now`). */
  now: Date;
}

/**
 * Insert a pending outbox row. Call it with the client of the surrounding transaction so
 * the message is committed atomically with the domain write it announces (FR-214).
 * Returns the new id, or null when `dedupeKey` already exists (nothing inserted).
 */
export async function enqueueOutbox(
  q: Queryable,
  input: EnqueueOutboxInput,
): Promise<string | null> {
  const { rows } = await q.query(
    `INSERT INTO outbox_message (kind, to_phone, body, dedupe_key, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [input.kind, input.toPhone, input.body, input.dedupeKey ?? null, input.now],
  );
  return rows[0] ? (rows[0].id as string) : null;
}

/**
 * Claim ONE due row for this transaction. `FOR UPDATE SKIP LOCKED` lets concurrent
 * dispatchers work the queue without ever picking the same row while both are alive.
 */
export async function claimDue(client: PoolClient, now: Date): Promise<OutboxRow | null> {
  const { rows } = await client.query(
    `SELECT id, kind, to_phone, body, attempts
     FROM outbox_message
     WHERE status = 'pending' AND next_attempt_at <= $1
     ORDER BY next_attempt_at, created_at
     LIMIT 1
     FOR UPDATE SKIP LOCKED`,
    [now],
  );
  const r = rows[0];
  if (!r) return null;
  return { id: r.id, kind: r.kind, toPhone: r.to_phone, body: r.body, attempts: r.attempts };
}

export async function markSent(
  q: Queryable,
  id: string,
  attempts: number,
  now: Date,
): Promise<void> {
  await q.query(
    "UPDATE outbox_message SET status = 'sent', attempts = $2, sent_at = $3, last_error = NULL WHERE id = $1",
    [id, attempts, now],
  );
}

export async function markRetry(
  q: Queryable,
  id: string,
  attempts: number,
  nextAttemptAt: Date,
  error: string,
): Promise<void> {
  await q.query(
    "UPDATE outbox_message SET attempts = $2, next_attempt_at = $3, last_error = $4 WHERE id = $1",
    [id, attempts, nextAttemptAt, error],
  );
}

export async function markFailed(
  q: Queryable,
  id: string,
  attempts: number,
  error: string,
): Promise<void> {
  await q.query(
    "UPDATE outbox_message SET status = 'failed', attempts = $2, last_error = $3 WHERE id = $1",
    [id, attempts, error],
  );
}

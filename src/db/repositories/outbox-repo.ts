import type { Pool, PoolClient } from "../pool";

type Queryable = Pool | PoolClient;

export type OutboxKind = "booking_confirmation" | "escalation";

export type OutboxStatus = "pending" | "sent" | "failed" | "cancelled";

export interface OutboxRow {
  id: string;
  kind: OutboxKind;
  toPhone: string;
  /** The patient this message is about (recipient may be reception). Null for system-wide notices. */
  conversationPhone: string | null;
  body: string;
  attempts: number;
}

export interface EnqueueOutboxInput {
  kind: OutboxKind;
  toPhone: string;
  /** The patient this message is about — lets a turn flush only its own conversation's rows. */
  conversationPhone?: string | null;
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
    `INSERT INTO outbox_message (kind, to_phone, conversation_phone, body, dedupe_key, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [
      input.kind,
      input.toPhone,
      input.conversationPhone ?? null,
      input.body,
      input.dedupeKey ?? null,
      input.now,
    ],
  );
  return rows[0] ? (rows[0].id as string) : null;
}

/**
 * Claim ONE due row for this transaction. `FOR UPDATE SKIP LOCKED` lets concurrent
 * dispatchers work the queue without ever picking the same row while both are alive.
 */
export async function claimDue(
  client: PoolClient,
  now: Date,
  conversationPhone?: string,
): Promise<OutboxRow | null> {
  const { rows } = await client.query(
    `SELECT id, kind, to_phone, conversation_phone, body, attempts
     FROM outbox_message
     WHERE status = 'pending' AND next_attempt_at <= $1
       AND ($2::text IS NULL OR conversation_phone = $2::text)
     ORDER BY next_attempt_at, created_at
     LIMIT 1
     FOR UPDATE SKIP LOCKED`,
    [now, conversationPhone ?? null],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    kind: r.kind,
    toPhone: r.to_phone,
    conversationPhone: r.conversation_phone,
    body: r.body,
    attempts: r.attempts,
  };
}

/**
 * Cancel every pending message addressed to `toPhone` (LGPD opt-out: the patient was just
 * told no more messages will come). Returns the cancelled ids for the audit trail.
 */
export async function cancelPendingForRecipient(q: Queryable, toPhone: string): Promise<string[]> {
  const { rows } = await q.query(
    `UPDATE outbox_message SET status = 'cancelled', last_error = 'cancelled: opt_out'
     WHERE to_phone = $1 AND status = 'pending'
     RETURNING id`,
    [toPhone],
  );
  return rows.map((r) => r.id as string);
}

/** Delivery status of the confirmation enqueued for a booking (by dedupe key), or null if none. */
export async function confirmationStatus(
  q: Queryable,
  bookingId: string,
): Promise<OutboxStatus | null> {
  const { rows } = await q.query("SELECT status FROM outbox_message WHERE dedupe_key = $1", [
    `booking_confirmation:${bookingId}`,
  ]);
  return rows[0] ? (rows[0].status as OutboxStatus) : null;
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

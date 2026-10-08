// 008 durable inbound pipeline: the queue between the webhook and the orchestrator. Same proven
// pattern as the outbox (FOR UPDATE SKIP LOCKED), plus a lease for crash recovery and a per-phone
// FIFO / one-in-flight condition so a patient's messages are handled in order, one at a time,
// across any number of workers.

import { randomUUID } from "node:crypto";
import type { InboundMessage } from "../../agent/types.ts";
import { escalationMessagePt } from "../../messages.ts";
import { currentTraceparent } from "../../telemetry/tracing.ts";
import type { Pool, PoolClient } from "../pool.ts";
import { appendAudit } from "./audit-repo.ts";
import { enqueueOutbox } from "./outbox-repo.ts";

type Queryable = Pool | PoolClient;

export type InboundProvider = "evolution" | "cloud";

export interface InboundRow {
  id: string;
  provider: InboundProvider;
  providerMessageId: string;
  phone: string;
  text: string;
  receivedAt: Date;
  attempts: number;
  traceContext: string | null;
  /**
   * This claim's lease token (a fencing token): `<workerId>/<uuid>`, new on every claim, so an
   * earlier attempt — even from another slot of the same worker — can never renew, finish or
   * write for a claim it no longer holds.
   */
  lease: string;
}

function toRow(r: Record<string, unknown>): InboundRow {
  return {
    id: String(r.id),
    provider: r.provider as InboundProvider,
    providerMessageId: r.provider_message_id as string,
    phone: r.phone as string,
    text: (r.body as string | null) ?? "",
    receivedAt: new Date(r.received_at as string),
    attempts: r.attempts as number,
    traceContext: (r.trace_context as string | null) ?? null,
    lease: r.locked_by as string,
  };
}

/**
 * Store one verified message (call it in the webhook's transaction, before acknowledging).
 * `duplicate` = this provider id was stored before (redelivery); `dropped` = the phone already has
 * `maxPending` unfinished messages (flood guard, kept for the audit trail, never processed).
 * The count and the insert run under a per-phone transaction lock, so concurrent deliveries for
 * one phone are admitted one at a time and never pass the limit together.
 */
export async function insertInbound(
  client: PoolClient,
  msg: InboundMessage,
  provider: InboundProvider,
  now: Date,
  maxPending: number,
): Promise<"inserted" | "duplicate" | "dropped"> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [
    `inbound:${msg.phone}`,
  ]);
  const { rows: open } = await client.query(
    "SELECT count(*)::int AS n FROM inbound_message WHERE phone = $1 AND status IN ('pending','processing')",
    [msg.phone],
  );
  const dropped = (open[0].n as number) >= maxPending;
  const { rows } = await client.query(
    `INSERT INTO inbound_message
       (provider, provider_message_id, phone, body, received_at, status, next_attempt_at, trace_context)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (provider, provider_message_id) DO NOTHING
     RETURNING id`,
    [
      provider,
      msg.providerMessageId,
      msg.phone,
      dropped ? null : msg.text,
      msg.receivedAt ?? now,
      dropped ? "dropped" : "pending",
      now,
      currentTraceparent(),
    ],
  );
  if (rows.length === 0) return "duplicate";
  return dropped ? "dropped" : "inserted";
}

/**
 * Claim the next message a worker may run: pending and due, or processing with an expired lease;
 * the OLDEST unfinished message of its phone; and no live lease on another message of that phone.
 * One statement, SKIP LOCKED: concurrent workers never take the same row nor two rows of a phone.
 * Each claim gets a fresh lease token (see `InboundRow.lease`).
 */
export async function claimNext(
  q: Queryable,
  workerId: string,
  now: Date,
  leaseMs: number,
): Promise<InboundRow | null> {
  const { rows } = await q.query(
    `UPDATE inbound_message
     SET status = 'processing', locked_by = $2, locked_until = $3, attempts = attempts + 1
     WHERE id = (
       SELECT m.id FROM inbound_message m
       WHERE ((m.status = 'pending' AND m.next_attempt_at <= $1)
              OR (m.status = 'processing' AND m.locked_until < $1))
         AND NOT EXISTS (
           SELECT 1 FROM inbound_message o
           WHERE o.phone = m.phone AND o.id < m.id AND o.status IN ('pending', 'processing'))
         AND NOT EXISTS (
           SELECT 1 FROM inbound_message o
           WHERE o.phone = m.phone AND o.id <> m.id
             AND o.status = 'processing' AND o.locked_until >= $1)
       ORDER BY m.id
       LIMIT 1
       FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [now, `${workerId}/${randomUUID()}`, new Date(now.getTime() + leaseMs)],
  );
  return rows[0] ? toRow(rows[0]) : null;
}

/**
 * True while `lease` still holds the message. Inside a write transaction it also locks the row
 * (FOR SHARE) until that transaction ends, so a takeover — whose claim skips locked rows — cannot
 * start until the write has committed, and then the replay guard sees it.
 */
export async function leaseHeld(q: Queryable, id: string, lease: string): Promise<boolean> {
  const { rows } = await q.query(
    `SELECT 1 FROM inbound_message
     WHERE id = $1 AND locked_by = $2 AND status = 'processing'
     FOR SHARE`,
    [id, lease],
  );
  return rows.length > 0;
}

/** Extend the holder's lease while its turn runs. False = the message was taken over. */
export async function heartbeat(
  q: Queryable,
  id: string,
  lease: string,
  now: Date,
  leaseMs: number,
): Promise<boolean> {
  const { rowCount } = await q.query(
    `UPDATE inbound_message SET locked_until = $3
     WHERE id = $1 AND locked_by = $2 AND status = 'processing'`,
    [id, lease, new Date(now.getTime() + leaseMs)],
  );
  return (rowCount ?? 0) > 0;
}

/** Finish a processed message (holder only) and clear its text (LGPD, FR-807). */
export async function markDone(
  q: Queryable,
  id: string,
  lease: string,
  now: Date,
): Promise<boolean> {
  const { rowCount } = await q.query(
    `UPDATE inbound_message
     SET status = 'done', body = NULL, processed_at = $3, locked_by = NULL, locked_until = NULL
     WHERE id = $1 AND locked_by = $2 AND status = 'processing'`,
    [id, lease, now],
  );
  return (rowCount ?? 0) > 0;
}

/** Back to pending after a failed attempt, due at `nextAt` (holder only). */
export async function markRetry(
  q: Queryable,
  id: string,
  lease: string,
  nextAt: Date,
  errorType: string,
): Promise<boolean> {
  const { rowCount } = await q.query(
    `UPDATE inbound_message
     SET status = 'pending', next_attempt_at = $3, last_error = $4, locked_by = NULL, locked_until = NULL
     WHERE id = $1 AND locked_by = $2 AND status = 'processing'`,
    [id, lease, nextAt, errorType],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * The last attempt failed (FR-805): mark the message dead, audit it and hand the patient to
 * reception — one transaction, holder only. The phone's later messages become claimable.
 */
export async function markDead(
  pool: Pool,
  id: string,
  lease: string,
  now: Date,
  errorType: string,
  receptionPhone: string,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE inbound_message
       SET status = 'dead', body = NULL, processed_at = $3, last_error = $4,
           locked_by = NULL, locked_until = NULL
       WHERE id = $1 AND locked_by = $2 AND status = 'processing'
       RETURNING phone, provider, attempts`,
      [id, lease, now, errorType],
    );
    if (!rows[0]) {
      await client.query("ROLLBACK");
      return false;
    }
    const { phone, provider, attempts } = rows[0] as {
      phone: string;
      provider: string;
      attempts: number;
    };
    await appendAudit(client, {
      entity: "inbound",
      entityId: null,
      action: "inbound_dead_letter",
      actor: "system",
      payload: { inboundId: id, provider, attempts, lastError: errorType },
    });
    const context = `Não foi possível processar uma mensagem do paciente após ${attempts} tentativas (${errorType}).`;
    const outboxId = await enqueueOutbox(client, {
      kind: "escalation",
      toPhone: receptionPhone,
      conversationPhone: phone,
      body: escalationMessagePt({ reason: "inbound_failed", phone, context, summary: [] }),
      dedupeKey: `inbound_failed:${id}`,
      now,
    });
    await appendAudit(client, {
      entity: "escalation",
      entityId: null,
      action: "escalated",
      actor: "system",
      payload: { reason: "inbound_failed", phone, context, summary: [], outboxId },
    });
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

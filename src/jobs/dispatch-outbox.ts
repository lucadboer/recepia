import type { PoolClient } from "../db/pool";
import { appendAudit } from "../db/repositories/audit-repo";
import {
  claimDue,
  enqueueOutbox,
  markFailed,
  markRetry,
  markSent,
  type OutboxRow,
} from "../db/repositories/outbox-repo";
import type { Deps } from "../deps";
import { escalationMessagePt } from "../messages";
import {
  ATTR,
  errorTypeOf,
  linkFromTraceparent,
  SPAN,
  setAttributes,
  withSpan,
} from "../telemetry/tracing";

/** Delay before attempt n+1 after the n-th failure (n = 1..). The last value repeats. */
export const OUTBOX_BACKOFF_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000];
/** The attempt whose failure dead-letters the row (~43 min of retries in total). */
export const OUTBOX_MAX_ATTEMPTS = 6;
/** Messaging adapters have no timeout of their own; bound each send here. */
export const OUTBOX_SEND_TIMEOUT_MS = 15_000;

export interface DispatchOutboxOptions {
  /** Max rows processed per call (one transaction each). Default 20. */
  batchSize?: number;
  sendTimeoutMs?: number;
  /**
   * Only deliver rows that belong to this conversation (the patient's own confirmation AND the
   * reception notice about them). The orchestrator uses it inside a turn, so one slow provider
   * never makes a patient wait on other conversations' retries — not even other patients'
   * escalations that share the reception phone.
   */
  conversationPhone?: string;
}

export interface DispatchOutboxResult {
  sent: number;
  retried: number;
  failed: number;
}

type Outcome = keyof DispatchOutboxResult;

const KIND_LABEL_PT: Record<OutboxRow["kind"], string> = {
  booking_confirmation: "a confirmação da consulta",
  escalation: "o aviso à recepção",
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Bound a send. NOTE (at-least-once): when the timeout fires the underlying request keeps
 * running; if the provider actually delivered, the row is retried and the recipient may get
 * the same message twice. Accepted for now (FR-214); provider message ids for idempotent
 * sends are planned with the durable inbound pipeline (feature 006).
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export function backoffFor(attempts: number): number {
  const idx = Math.min(Math.max(attempts - 1, 0), OUTBOX_BACKOFF_MS.length - 1);
  return OUTBOX_BACKOFF_MS[idx];
}

/**
 * Deliver due outbox rows. One row per transaction: claim (SKIP LOCKED) → send → mark →
 * COMMIT, so a crash mid-send rolls the claim back and the row is retried (at-least-once).
 * After OUTBOX_MAX_ATTEMPTS the row is dead-lettered: `failed` + `outbox_dead_letter` audit
 * + an escalation row for reception (a dead-lettered escalation only audits — no loop).
 */
export async function dispatchOutbox(
  deps: Deps,
  opts: DispatchOutboxOptions = {},
): Promise<DispatchOutboxResult> {
  const batchSize = opts.batchSize ?? 20;
  const timeoutMs = opts.sendTimeoutMs ?? OUTBOX_SEND_TIMEOUT_MS;
  const result: DispatchOutboxResult = { sent: 0, retried: 0, failed: 0 };
  for (let i = 0; i < batchSize; i++) {
    const outcome = await dispatchOne(deps, timeoutMs, opts.conversationPhone);
    if (outcome === null) break;
    result[outcome]++;
  }
  return result;
}

async function dispatchOne(
  deps: Deps,
  timeoutMs: number,
  conversationPhone?: string,
): Promise<Outcome | null> {
  const now = deps.clock.now();
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    const row = await claimDue(client, now, conversationPhone);
    if (!row) {
      await client.query("COMMIT");
      return null;
    }
    const attempts = row.attempts + 1;
    const link = linkFromTraceparent(row.traceContext);
    // FR-504: one span per delivery attempt, linked to the turn that committed the message.
    const outcome = await withSpan(
      SPAN.outboxDispatch,
      { [ATTR.outboxKind]: row.kind, [ATTR.outboxAttempt]: attempts },
      async (span): Promise<Outcome> => {
        let o: Outcome;
        try {
          await withTimeout(deps.messaging.sendMessage(row.toPhone, row.body), timeoutMs);
          await markSent(client, row.id, attempts, deps.clock.now());
          o = "sent";
        } catch (sendErr) {
          const message = errorMessage(sendErr);
          // Backoff counts from the moment the send FAILED, not from the claim: a send that took
          // longer than the backoff must not come due again inside the same batch.
          const failedAt = deps.clock.now();
          if (attempts >= OUTBOX_MAX_ATTEMPTS) {
            await deadLetter(deps, client, row, attempts, message, failedAt);
            o = "failed";
          } else {
            const nextAt = new Date(failedAt.getTime() + backoffFor(attempts));
            await markRetry(client, row.id, attempts, nextAt, message);
            o = "retried";
          }
          setAttributes(span, {
            [ATTR.errorType]: errorTypeOf(sendErr),
          });
        }
        setAttributes(span, { [ATTR.outboxResult]: o });
        return o;
      },
      { links: link ? [link] : [] },
    );
    await client.query("COMMIT");
    return outcome;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function deadLetter(
  deps: Deps,
  client: PoolClient,
  row: OutboxRow,
  attempts: number,
  lastError: string,
  now: Date,
): Promise<void> {
  await markFailed(client, row.id, attempts, lastError);
  await appendAudit(client, {
    entity: "outbox",
    entityId: row.id,
    action: "outbox_dead_letter",
    actor: "system",
    payload: { kind: row.kind, toPhone: row.toPhone, attempts, lastError },
  });
  if (row.kind === "escalation") return; // never escalate a failed escalation (no loop)

  const context = `Não foi possível entregar ${KIND_LABEL_PT[row.kind]} após ${attempts} tentativas (${lastError}).`;
  const escalationId = await enqueueOutbox(client, {
    kind: "escalation",
    toPhone: deps.receptionPhone,
    conversationPhone: row.conversationPhone,
    body: escalationMessagePt({
      reason: "delivery_failed",
      phone: row.toPhone,
      context,
      summary: [],
    }),
    now,
  });
  await appendAudit(client, {
    entity: "escalation",
    entityId: null,
    action: "escalated",
    actor: "system",
    payload: {
      reason: "delivery_failed",
      context,
      phone: row.toPhone,
      summary: [],
      outboxId: escalationId,
    },
  });
}

// LGPD retention (owner decision T222, 2026-10-06; feature 005 FR-515): conversation state and
// terminal outbox messages are deleted after 90 days without activity. The consent ledger and the
// audit log are kept; pending messages are never deleted. Every run is audited with counts only.

import type { Pool } from "../db/pool";
import { appendAudit } from "../db/repositories/audit-repo";
import { SPAN, setAttributes, withSpan } from "../telemetry/tracing";

export const RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionOptions {
  olderThanDays?: number;
  dryRun?: boolean;
}

export interface RetentionResult {
  conversationStates: number;
  outboxMessages: number;
  olderThanDays: number;
  cutoff: string;
  dryRun: boolean;
}

const STATE_WHERE = "updated_at < $1";
const OUTBOX_WHERE = "status IN ('sent', 'failed', 'cancelled') AND created_at < $1";

export async function purgeInactive(
  pool: Pool,
  now: Date,
  { olderThanDays = RETENTION_DAYS, dryRun = false }: RetentionOptions = {},
): Promise<RetentionResult> {
  if (!Number.isInteger(olderThanDays) || olderThanDays <= 0) {
    throw new Error(`olderThanDays must be a positive integer, got ${olderThanDays}`);
  }
  const cutoff = new Date(now.getTime() - olderThanDays * DAY_MS);
  return withSpan(
    SPAN.job("retention"),
    { "recepia.retention.days": olderThanDays, "recepia.retention.dry_run": dryRun },
    async (span) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        let states: number;
        let messages: number;
        if (dryRun) {
          states = Number(
            (
              await client.query(
                `SELECT count(*)::int AS n FROM conversation_state WHERE ${STATE_WHERE}`,
                [cutoff],
              )
            ).rows[0].n,
          );
          messages = Number(
            (
              await client.query(
                `SELECT count(*)::int AS n FROM outbox_message WHERE ${OUTBOX_WHERE}`,
                [cutoff],
              )
            ).rows[0].n,
          );
        } else {
          states =
            (await client.query(`DELETE FROM conversation_state WHERE ${STATE_WHERE}`, [cutoff]))
              .rowCount ?? 0;
          messages =
            (await client.query(`DELETE FROM outbox_message WHERE ${OUTBOX_WHERE}`, [cutoff]))
              .rowCount ?? 0;
          await appendAudit(client, {
            entity: "retention",
            entityId: null,
            action: "retention_purged",
            actor: "system",
            payload: {
              conversationStates: states,
              outboxMessages: messages,
              olderThanDays,
              cutoff: cutoff.toISOString(),
            },
          });
        }
        await client.query("COMMIT");
        setAttributes(span, {
          "recepia.retention.conversation_states": states,
          "recepia.retention.outbox_messages": messages,
        });
        return {
          conversationStates: states,
          outboxMessages: messages,
          olderThanDays,
          cutoff: cutoff.toISOString(),
          dryRun,
        };
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    { root: true },
  );
}

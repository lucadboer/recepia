import { fileURLToPath } from "node:url";
import { resetConversation } from "../agent/conversation";
import { loadEnv } from "../db/env";
import { makePool, type Pool } from "../db/pool";
import { appendAudit } from "../db/repositories/audit-repo";
import { DbConversationStore } from "../db/repositories/conversation-repo";

/**
 * Reception releases a handed-off conversation (FR-211): the next patient message is
 * handled autonomously again. Resets the state (keeping dedupe ids) and writes a
 * `conversation_released` audit row (actor human) in the same transaction.
 * Returns false when there is nothing to release (unknown phone or not escalated).
 */
export async function releaseConversation(pool: Pool, phone: string, now: Date): Promise<boolean> {
  const store = new DbConversationStore(pool);
  const current = await store.load(phone);
  if (!current || current.status !== "escalated") return false;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await store.save(resetConversation(current, now), client);
    await appendAudit(client, {
      entity: "conversation",
      entityId: null,
      action: "conversation_released",
      actor: "human",
      payload: { phone, escalatedAt: current.escalatedAt },
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

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  const phone = process.argv[2];
  if (!phone) {
    console.error("usage: pnpm conversation:release <phone>   (e.g. +5511999998888)");
    process.exit(2);
  }
  loadEnv();
  const pool = makePool();
  releaseConversation(pool, phone, new Date())
    .then((released) => {
      console.log(
        released
          ? `released: ${phone} — the next message is handled autonomously again`
          : `nothing to release for ${phone} (unknown or not handed off)`,
      );
      return pool.end();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

import { emptyUsage } from "../../agent/conversation";
import type { ConversationState } from "../../agent/types";
import { ConversationConflictError } from "../../domain/errors";
import type { ConversationStorePort, SaveOptions } from "../../ports/conversation-store-port";
import type { Pool, PoolClient } from "../pool";

type Queryable = Pool | PoolClient;

/** Postgres-backed ConversationStorePort. The in-memory fake stays the test default. */
export class DbConversationStore implements ConversationStorePort {
  constructor(private readonly pool: Pool) {}

  /** Pass the client of a surrounding transaction to read inside it. */
  async load(phone: string, q: Queryable = this.pool): Promise<ConversationState | null> {
    const { rows } = await q.query(
      "SELECT state, version FROM conversation_state WHERE phone = $1",
      [phone],
    );
    if (!rows[0]) return null;
    const parsed = rows[0].state as ConversationState;
    // The column is authoritative for the version; the JSON copy is informational.
    return {
      ...parsed,
      promptVersion: parsed.promptVersion ?? null, // rows written before FR-409 lack the field
      usage: parsed.usage ?? emptyUsage(), // rows written before feature 005 lack the field
      turnSeq: parsed.turnSeq ?? 0, // rows written before feature 006 lack these three
      surfacedBookings: parsed.surfacedBookings ?? [],
      holdSeqs: parsed.holdSeqs ?? [],
      version: rows[0].version as number,
      updatedAt: new Date(parsed.updatedAt),
    };
  }

  /**
   * Compare-and-swap upsert (T240): a fresh state (version 0) inserts version 1; an
   * existing row is updated only if its version still equals the one we loaded. Zero
   * rows affected means someone else saved first → ConversationConflictError.
   * Pass `client` (a surrounding transaction) to save atomically with other writes; a `fence`
   * runs in the same transaction as the write (008).
   */
  async save(
    state: ConversationState,
    opts: SaveOptions & { client?: PoolClient } = {},
  ): Promise<ConversationState> {
    if (opts.client) {
      await opts.fence?.(opts.client);
      return upsert(opts.client, state);
    }
    if (!opts.fence) return upsert(this.pool, state);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await opts.fence(client);
      const saved = await upsert(client, state);
      await client.query("COMMIT");
      return saved;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}

/** The compare-and-swap upsert itself (see `DbConversationStore.save`). */
async function upsert(q: Queryable, state: ConversationState): Promise<ConversationState> {
  const { rows } = await q.query(
    `INSERT INTO conversation_state (phone, state, version, updated_at) VALUES ($1, $2, 1, now())
     ON CONFLICT (phone) DO UPDATE
       SET state = EXCLUDED.state, version = conversation_state.version + 1, updated_at = now()
       WHERE conversation_state.version = $3
     RETURNING version`,
    [state.phone, JSON.stringify(state), state.version],
  );
  if (!rows[0]) throw new ConversationConflictError(state.phone, state.version);
  return { ...state, version: rows[0].version as number };
}

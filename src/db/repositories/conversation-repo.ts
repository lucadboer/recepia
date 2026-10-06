import type { ConversationState } from "../../agent/types";
import type { ConversationStorePort } from "../../ports/conversation-store-port";
import type { Pool, PoolClient } from "../pool";

type Queryable = Pool | PoolClient;

/** Postgres-backed ConversationStorePort. The in-memory fake stays the test default. */
export class DbConversationStore implements ConversationStorePort {
  constructor(private readonly pool: Pool) {}

  async load(phone: string): Promise<ConversationState | null> {
    const { rows } = await this.pool.query(
      "SELECT state FROM conversation_state WHERE phone = $1",
      [phone],
    );
    if (!rows[0]) return null;
    const parsed = rows[0].state as ConversationState;
    return { ...parsed, updatedAt: new Date(parsed.updatedAt) };
  }

  /** Upsert. Pass the client of a surrounding transaction to save atomically with other writes. */
  async save(state: ConversationState, q: Queryable = this.pool): Promise<void> {
    await q.query(
      `INSERT INTO conversation_state (phone, state, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (phone) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
      [state.phone, JSON.stringify(state)],
    );
  }
}

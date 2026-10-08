import type { ConversationState } from "../agent/types";
import type { PoolClient } from "../db/pool";

export interface SaveOptions {
  /**
   * Must pass for the save to happen (008: the turn still owns its inbound message). The Postgres
   * store runs it inside the save's own transaction, so nothing can take the message over between
   * the check and the write; the in-memory store runs it just before saving.
   */
  fence?: (tx?: PoolClient) => Promise<void>;
}

/**
 * Persist per-phone conversation state. `save` is a compare-and-swap on `state.version`:
 * it returns the persisted state (version + 1) or throws ConversationConflictError when
 * another save got there first (T240). Fake (in-memory) + Postgres store satisfy this.
 */
export interface ConversationStorePort {
  load(phone: string): Promise<ConversationState | null>;
  save(state: ConversationState, opts?: SaveOptions): Promise<ConversationState>;
}

import type { ConversationState } from "../agent/types";

/**
 * Persist per-phone conversation state. `save` is a compare-and-swap on `state.version`:
 * it returns the persisted state (version + 1) or throws ConversationConflictError when
 * another save got there first (T240). Fake (in-memory) + Postgres store satisfy this.
 */
export interface ConversationStorePort {
  load(phone: string): Promise<ConversationState | null>;
  save(state: ConversationState): Promise<ConversationState>;
}

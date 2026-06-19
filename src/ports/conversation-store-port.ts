import type { ConversationState } from "../agent/types";

/** Persist per-phone conversation state. Fake (in-memory) + DB scaffold satisfy this. */
export interface ConversationStorePort {
  load(phone: string): Promise<ConversationState | null>;
  save(state: ConversationState): Promise<void>;
}

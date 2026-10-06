import type { ConversationState } from "../../agent/types";
import { ConversationConflictError } from "../../domain/errors";
import type { ConversationStorePort } from "../../ports/conversation-store-port";

/**
 * In-memory ConversationStorePort for tests/dev. Stores copies to avoid aliasing and
 * mirrors the DB store's compare-and-swap on `version` so fake-based tests catch lost
 * updates too (T240).
 */
export class FakeConversationStore implements ConversationStorePort {
  readonly map = new Map<string, ConversationState>();

  async load(phone: string): Promise<ConversationState | null> {
    const s = this.map.get(phone);
    return s ? structuredClone(s) : null;
  }

  async save(state: ConversationState): Promise<ConversationState> {
    const currentVersion = this.map.get(state.phone)?.version ?? 0;
    if (state.version !== currentVersion) {
      throw new ConversationConflictError(state.phone, state.version);
    }
    const saved: ConversationState = { ...structuredClone(state), version: currentVersion + 1 };
    this.map.set(state.phone, saved);
    return structuredClone(saved);
  }
}

import type { ConversationState } from "../../agent/types";
import type { ConversationStorePort } from "../../ports/conversation-store-port";

/** In-memory ConversationStorePort for tests/dev. Stores copies to avoid aliasing. */
export class FakeConversationStore implements ConversationStorePort {
  readonly map = new Map<string, ConversationState>();

  async load(phone: string): Promise<ConversationState | null> {
    const s = this.map.get(phone);
    return s ? structuredClone(s) : null;
  }

  async save(state: ConversationState): Promise<void> {
    this.map.set(state.phone, structuredClone(state));
  }
}

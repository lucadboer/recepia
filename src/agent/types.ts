import type { LlmMessage } from "../ports/llm-port";

/** A normalized inbound patient message (from any provider parser). */
export interface InboundMessage {
  phone: string;
  text: string;
  providerMessageId: string; // for idempotency
  receivedAt?: Date;
}

/** Per-phone orchestration state. `offeredSlots`/`activeHoldIds` back the structural guardrails. */
export interface ConversationState {
  phone: string;
  status: "active" | "escalated" | "completed";
  history: LlmMessage[];
  offeredSlots: string[]; // ISO start strings returned by get_availability
  activeHoldIds: string[]; // hold ids created in THIS conversation
  lastConfirmedBookingId: string | null;
  processedInboundIds: string[];
  patientName: string | null;
  awaitingConsent: boolean; // set when confirm was blocked pending opt-in
  escalatedAt: string | null; // ISO; when the conversation was handed to reception (FR-211)
  handoffNoticeAt: string | null; // ISO; last "a recepção vai continuar" notice (FR-211)
  promptVersion: string | null; // last system prompt version the model was given (FR-409)
  version: number; // optimistic concurrency; 0 = never persisted (T240)
  updatedAt: Date;
}

export interface LoopResult {
  status: "replied" | "escalated" | "noop" | "max_iterations" | "handed_off";
  reply?: string;
}

// Pure reducers over ConversationState. No I/O — fully unit-testable.

import type { LlmMessage } from "../ports/llm-port";
import type { ConversationState } from "./types";

export function emptyState(phone: string, now: Date): ConversationState {
  return {
    phone,
    status: "active",
    history: [],
    offeredSlots: [],
    activeHoldIds: [],
    lastConfirmedBookingId: null,
    processedInboundIds: [],
    patientName: null,
    updatedAt: now,
  };
}

export function appendMessage(s: ConversationState, m: LlmMessage, now: Date): ConversationState {
  return { ...s, history: [...s.history, m], updatedAt: now };
}

export function appendUserText(s: ConversationState, text: string, now: Date): ConversationState {
  return appendMessage(s, { role: "user", content: [{ type: "text", text }] }, now);
}

export function recordOfferedSlots(
  s: ConversationState,
  isoStarts: string[],
  now: Date,
): ConversationState {
  const merged = new Set([...s.offeredSlots, ...isoStarts]);
  return { ...s, offeredSlots: [...merged], updatedAt: now };
}

export function recordHold(s: ConversationState, holdId: string, now: Date): ConversationState {
  if (s.activeHoldIds.includes(holdId)) return s;
  return { ...s, activeHoldIds: [...s.activeHoldIds, holdId], updatedAt: now };
}

export function recordConfirmed(
  s: ConversationState,
  bookingId: string,
  now: Date,
): ConversationState {
  return { ...s, lastConfirmedBookingId: bookingId, status: "completed", updatedAt: now };
}

export function markEscalated(s: ConversationState, now: Date): ConversationState {
  return { ...s, status: "escalated", updatedAt: now };
}

export function markProcessed(
  s: ConversationState,
  inboundId: string,
  now: Date,
): ConversationState {
  if (s.processedInboundIds.includes(inboundId)) return s;
  return { ...s, processedInboundIds: [...s.processedInboundIds, inboundId], updatedAt: now };
}

export function isProcessed(s: ConversationState, inboundId: string): boolean {
  return s.processedInboundIds.includes(inboundId);
}

export function isOfferedSlot(s: ConversationState, iso: string): boolean {
  return s.offeredSlots.includes(iso);
}

export function hasActiveHold(s: ConversationState, holdId: string): boolean {
  return s.activeHoldIds.includes(holdId);
}

// Pure reducers over ConversationState. No I/O — fully unit-testable.

import {
  ACTIVE_HOLDS_MAX,
  HISTORY_MAX_MESSAGES,
  OFFERED_SLOTS_MAX,
  PROCESSED_IDS_MAX,
} from "../config";
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
    awaitingConsent: false,
    updatedAt: now,
  };
}

export function setAwaitingConsent(
  s: ConversationState,
  awaiting: boolean,
  now: Date,
): ConversationState {
  return { ...s, awaitingConsent: awaiting, updatedAt: now };
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

// ---------------------------------------------------------------------------
// Bounds (T239). State must not grow without limit: the whole history is sent to
// the LLM every turn and the JSONB row is loaded/saved on every message.
// ---------------------------------------------------------------------------

function isUserText(m: LlmMessage): boolean {
  return m.role === "user" && !m.content.some((c) => c.type === "tool_result");
}

/**
 * Keep at most `max` messages, cutting only at a user TEXT message so that an
 * assistant `tool_use` is never separated from the `tool_result` that must follow
 * it (Anthropic rejects such histories). If no safe boundary exists inside the
 * trimmable window the history is left unchanged.
 */
export function trimHistory(s: ConversationState, max = HISTORY_MAX_MESSAGES): ConversationState {
  if (s.history.length <= max) return s;
  const minStart = s.history.length - max;
  for (let i = minStart; i < s.history.length; i++) {
    if (isUserText(s.history[i])) return { ...s, history: s.history.slice(i) };
  }
  return s;
}

/** Drop offered slots that already started (unbookable) and cap to the most recent `max`. */
export function pruneOfferedSlots(
  s: ConversationState,
  now: Date,
  max = OFFERED_SLOTS_MAX,
): ConversationState {
  const future = s.offeredSlots.filter((iso) => new Date(iso).getTime() > now.getTime());
  const kept = future.length > max ? future.slice(future.length - max) : future;
  if (kept.length === s.offeredSlots.length) return s;
  return { ...s, offeredSlots: kept };
}

function capTail<T>(xs: T[], max: number): T[] {
  return xs.length > max ? xs.slice(xs.length - max) : xs;
}

/** Apply every bound. Returns the same reference when nothing had to change. */
export function boundState(s: ConversationState, now: Date): ConversationState {
  let out = trimHistory(s);
  out = pruneOfferedSlots(out, now);
  const holds = capTail(out.activeHoldIds, ACTIVE_HOLDS_MAX);
  const processed = capTail(out.processedInboundIds, PROCESSED_IDS_MAX);
  if (holds !== out.activeHoldIds || processed !== out.processedInboundIds) {
    out = { ...out, activeHoldIds: holds, processedInboundIds: processed };
  }
  return out;
}

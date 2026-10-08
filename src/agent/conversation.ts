// Pure reducers over ConversationState. No I/O — fully unit-testable.

import {
  ACTIVE_HOLDS_MAX,
  HANDOFF_NOTICE_INTERVAL_MS,
  HISTORY_MAX_MESSAGES,
  OFFERED_SLOTS_MAX,
  PROCESSED_IDS_MAX,
  SURFACED_BOOKINGS_MAX,
} from "../config";
import type { LlmMessage, LlmUsage } from "../ports/llm-port";
import type { ConversationState, ConversationUsage } from "./types";

export function emptyUsage(): ConversationUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    calls: 0,
    models: [],
  };
}

/** Add one model call's usage and estimated cost (005 FR-509). */
export function addUsage(
  s: ConversationState,
  call: { usage?: LlmUsage; costUsd: number; model?: string },
  now: Date,
): ConversationState {
  const u = s.usage;
  const models =
    call.model && !u.models.includes(call.model) ? [...u.models, call.model] : u.models;
  return {
    ...s,
    usage: {
      inputTokens: u.inputTokens + (call.usage?.inputTokens ?? 0),
      outputTokens: u.outputTokens + (call.usage?.outputTokens ?? 0),
      cacheReadTokens: u.cacheReadTokens + (call.usage?.cacheReadTokens ?? 0),
      cacheWriteTokens: u.cacheWriteTokens + (call.usage?.cacheWriteTokens ?? 0),
      costUsd: u.costUsd + call.costUsd,
      calls: u.calls + 1,
      models,
    },
    updatedAt: now,
  };
}

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
    escalatedAt: null,
    handoffNoticeAt: null,
    promptVersion: null,
    usage: emptyUsage(),
    turnSeq: 0,
    surfacedBookings: [],
    holdSeqs: [],
    version: 0,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Confirmation memory (006): what the patient was shown, and in which inbound turn.
// ---------------------------------------------------------------------------

/** One accepted inbound message = one turn (006 FR-603). */
export function startTurn(s: ConversationState, now: Date): ConversationState {
  return { ...s, turnSeq: s.turnSeq + 1, updatedAt: now };
}

/** find_my_booking showed this booking. The FIRST turn is kept: re-showing never resets it. */
export function recordSurfacedBooking(
  s: ConversationState,
  bookingId: string,
  now: Date,
): ConversationState {
  if (s.surfacedBookings.some((b) => b.bookingId === bookingId)) return s;
  const next = [...s.surfacedBookings, { bookingId, turn: s.turnSeq }];
  return { ...s, surfacedBookings: capTail(next, SURFACED_BOOKINGS_MAX), updatedAt: now };
}

export function surfacedTurnOf(s: ConversationState, bookingId: string): number | null {
  return s.surfacedBookings.find((b) => b.bookingId === bookingId)?.turn ?? null;
}

/** hold_slot created this hold in the current turn (once). */
export function recordHoldTurn(s: ConversationState, holdId: string, now: Date): ConversationState {
  if (s.holdSeqs.some((h) => h.holdId === holdId)) return s;
  return { ...s, holdSeqs: [...s.holdSeqs, { holdId, turn: s.turnSeq }], updatedAt: now };
}

export function holdTurnOf(s: ConversationState, holdId: string): number | null {
  return s.holdSeqs.find((h) => h.holdId === holdId)?.turn ?? null;
}

/** Record which prompt artifact the model is being driven with this turn (FR-409). */
export function setPromptVersion(
  s: ConversationState,
  version: string,
  now: Date,
): ConversationState {
  if (s.promptVersion === version) return s;
  return { ...s, promptVersion: version, updatedAt: now };
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

/**
 * Record what get_availability just showed the model. Re-offered slots move to the TAIL:
 * "most recently offered" is what the cap in pruneOfferedSlots must preserve.
 */
export function recordOfferedSlots(
  s: ConversationState,
  isoStarts: string[],
  now: Date,
): ConversationState {
  const fresh = [...new Set(isoStarts)];
  const freshSet = new Set(fresh);
  const kept = s.offeredSlots.filter((iso) => !freshSet.has(iso));
  return { ...s, offeredSlots: [...kept, ...fresh], updatedAt: now };
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

/** A cancel finished the patient's request: the next message starts a fresh conversation (006). */
export function markCompleted(s: ConversationState, now: Date): ConversationState {
  return { ...s, status: "completed", updatedAt: now };
}

export function markEscalated(s: ConversationState, now: Date): ConversationState {
  return { ...s, status: "escalated", escalatedAt: now.toISOString(), updatedAt: now };
}

/**
 * A replayed message whose turn already committed (008 replay guard): give the conversation the
 * status those writes imply, as the original turn would have saved it — handed off if it
 * escalated, finished (with the booking) if it booked or rescheduled, finished if it cancelled or
 * confirmed attendance.
 */
export function applyCommittedTurn(
  s: ConversationState,
  committed: { action: string; entityId: string | null }[],
  now: Date,
): ConversationState {
  if (committed.length === 0) return s;
  if (committed.some((w) => w.action === "escalated")) return markEscalated(s, now);
  const booked = committed.find(
    (w) => (w.action === "booking_confirmed" || w.action === "booking_rescheduled") && w.entityId,
  );
  if (booked?.entityId) return recordConfirmed(s, booked.entityId, now);
  return markCompleted(s, now);
}

// ---------------------------------------------------------------------------
// Handed-off state (FR-211) and completed-reset (FR-212) — T237.
// ---------------------------------------------------------------------------

/** At most one "a recepção vai continuar" notice per interval while handed off. */
export function shouldSendHandoffNotice(
  s: ConversationState,
  now: Date,
  intervalMs = HANDOFF_NOTICE_INTERVAL_MS,
): boolean {
  if (!s.handoffNoticeAt) return true;
  return now.getTime() - new Date(s.handoffNoticeAt).getTime() >= intervalMs;
}

export function markHandoffNoticed(s: ConversationState, now: Date): ConversationState {
  return { ...s, handoffNoticeAt: now.toISOString(), updatedAt: now };
}

/** Optional safety valve: an escalated conversation whose TTL elapsed may resume autonomously. */
export function isAutoReleaseDue(s: ConversationState, now: Date, ttlMs: number): boolean {
  if (s.status !== "escalated" || !s.escalatedAt) return false;
  return now.getTime() - new Date(s.escalatedAt).getTime() >= ttlMs;
}

/**
 * Start a fresh conversation for the same patient. Keeps what must survive: the
 * processed message ids (dedupe, FR-207), the known name and the last confirmed booking.
 */
export function resetConversation(s: ConversationState, now: Date): ConversationState {
  return {
    ...emptyState(s.phone, now),
    processedInboundIds: s.processedInboundIds,
    patientName: s.patientName,
    lastConfirmedBookingId: s.lastConfirmedBookingId,
    version: s.version, // the row still exists — keep the CAS chain intact
  };
}

export function markProcessed(
  s: ConversationState,
  inboundId: string,
  now: Date,
): ConversationState {
  if (s.processedInboundIds.includes(inboundId)) return s;
  return { ...s, processedInboundIds: [...s.processedInboundIds, inboundId], updatedAt: now };
}

/**
 * Drop provider reasoning blocks before persisting (004 R1): the history is edited between
 * inbound turns (dated prompt line, trimming), which would invalidate a replayed block's
 * signature. An assistant message left empty (reasoning only) is dropped too — the API
 * rejects empty assistant content. Same reference when nothing changes.
 */
export function stripThinking(s: ConversationState): ConversationState {
  if (!s.history.some((m) => m.content.some((c) => c.type === "thinking"))) return s;
  const history: LlmMessage[] = [];
  for (const m of s.history) {
    const content = m.content.filter((c) => c.type !== "thinking");
    if (content.length === 0) continue;
    history.push(content.length === m.content.length ? m : { ...m, content });
  }
  return { ...s, history };
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
  const holdSeqs = capTail(out.holdSeqs, ACTIVE_HOLDS_MAX);
  const surfaced = capTail(out.surfacedBookings, SURFACED_BOOKINGS_MAX);
  if (
    holds !== out.activeHoldIds ||
    processed !== out.processedInboundIds ||
    holdSeqs !== out.holdSeqs ||
    surfaced !== out.surfacedBookings
  ) {
    out = {
      ...out,
      activeHoldIds: holds,
      processedInboundIds: processed,
      holdSeqs,
      surfacedBookings: surfaced,
    };
  }
  return out;
}

import { describe, expect, it } from "vitest";
import {
  appendUserText,
  applyCommittedTurn,
  emptyState,
  hasActiveHold,
  isAutoReleaseDue,
  isOfferedSlot,
  isProcessed,
  markEscalated,
  markHandoffNoticed,
  markProcessed,
  recordConfirmed,
  recordHold,
  recordOfferedSlots,
  resetConversation,
  shouldSendHandoffNotice,
} from "../../src/agent/conversation";
import { HANDOFF_NOTICE_INTERVAL_MS } from "../../src/config";

const NOW = new Date("2026-06-15T12:00:00Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);

describe("conversation reducers (pure)", () => {
  it("emptyState starts active and empty", () => {
    const s = emptyState("+55a", NOW);
    expect(s.status).toBe("active");
    expect(s.history).toHaveLength(0);
    expect(s.offeredSlots).toHaveLength(0);
    expect(s.activeHoldIds).toHaveLength(0);
  });

  it("appendUserText is immutable and appends", () => {
    const s0 = emptyState("+55a", NOW);
    const s1 = appendUserText(s0, "oi", NOW);
    expect(s0.history).toHaveLength(0); // original untouched
    expect(s1.history).toHaveLength(1);
    expect(s1.history[0]).toEqual({ role: "user", content: [{ type: "text", text: "oi" }] });
  });

  it("recordOfferedSlots dedups and is queryable", () => {
    let s = emptyState("+55a", NOW);
    s = recordOfferedSlots(s, ["2026-06-15T14:00:00.000Z"], NOW);
    s = recordOfferedSlots(s, ["2026-06-15T14:00:00.000Z", "2026-06-15T14:30:00.000Z"], NOW);
    expect(s.offeredSlots).toHaveLength(2);
    expect(isOfferedSlot(s, "2026-06-15T14:30:00.000Z")).toBe(true);
    expect(isOfferedSlot(s, "2026-06-15T15:00:00.000Z")).toBe(false);
  });

  it("recordOfferedSlots moves re-offered slots to the TAIL (most recently offered last)", () => {
    let s = emptyState("+55a", NOW);
    s = recordOfferedSlots(s, ["A", "B"], NOW);
    s = recordOfferedSlots(s, ["B", "C"], NOW);
    expect(s.offeredSlots).toEqual(["A", "B", "C"]);
    s = recordOfferedSlots(s, ["A"], NOW);
    expect(s.offeredSlots).toEqual(["B", "C", "A"]);
  });

  it("recordHold dedups and is queryable", () => {
    let s = emptyState("+55a", NOW);
    s = recordHold(s, "hold-1", NOW);
    s = recordHold(s, "hold-1", NOW);
    expect(s.activeHoldIds).toEqual(["hold-1"]);
    expect(hasActiveHold(s, "hold-1")).toBe(true);
    expect(hasActiveHold(s, "hold-x")).toBe(false);
  });

  it("recordConfirmed completes the conversation", () => {
    const s = recordConfirmed(emptyState("+55a", NOW), "booking-9", NOW);
    expect(s.status).toBe("completed");
    expect(s.lastConfirmedBookingId).toBe("booking-9");
  });

  it("markEscalated records when the hand-off happened (FR-211)", () => {
    const s = markEscalated(emptyState("+55a", NOW), NOW);
    expect(s.status).toBe("escalated");
    expect(s.escalatedAt).toBe(NOW.toISOString());
    expect(s.handoffNoticeAt).toBeNull();
  });

  it("shouldSendHandoffNotice: first time yes, inside the interval no, after it yes again", () => {
    const s = markEscalated(emptyState("+55a", NOW), NOW);
    expect(shouldSendHandoffNotice(s, NOW)).toBe(true);
    const noticed = markHandoffNoticed(s, NOW);
    expect(noticed.handoffNoticeAt).toBe(NOW.toISOString());
    expect(shouldSendHandoffNotice(noticed, at(HANDOFF_NOTICE_INTERVAL_MS - 1))).toBe(false);
    expect(shouldSendHandoffNotice(noticed, at(HANDOFF_NOTICE_INTERVAL_MS))).toBe(true);
  });

  it("isAutoReleaseDue only for an escalated conversation whose TTL elapsed", () => {
    const active = emptyState("+55a", NOW);
    expect(isAutoReleaseDue(active, at(1e9), 1000)).toBe(false);
    const esc = markEscalated(active, NOW);
    expect(isAutoReleaseDue(esc, at(999), 1000)).toBe(false);
    expect(isAutoReleaseDue(esc, at(1000), 1000)).toBe(true);
  });

  it("resetConversation starts fresh but keeps dedupe ids, name and last booking (FR-212)", () => {
    let s = emptyState("+55a", NOW);
    s = appendUserText(s, "oi", NOW);
    s = recordOfferedSlots(s, ["2026-06-15T14:00:00.000Z"], NOW);
    s = recordHold(s, "h1", NOW);
    s = markProcessed(s, "m1", NOW);
    s = recordConfirmed(s, "b1", NOW);
    s = { ...s, patientName: "João", awaitingConsent: true };
    s = markEscalated(s, NOW);
    s = markHandoffNoticed(s, NOW);

    const r = resetConversation(s, at(5000));

    expect(r.phone).toBe("+55a");
    expect(r.status).toBe("active");
    expect(r.history).toEqual([]);
    expect(r.offeredSlots).toEqual([]);
    expect(r.activeHoldIds).toEqual([]);
    expect(r.awaitingConsent).toBe(false);
    expect(r.escalatedAt).toBeNull();
    expect(r.handoffNoticeAt).toBeNull();
    expect(r.processedInboundIds).toEqual(["m1"]);
    expect(r.patientName).toBe("João");
    expect(r.lastConfirmedBookingId).toBe("b1");
    expect(r.updatedAt).toEqual(at(5000));
  });

  it("markProcessed dedups inbound ids (idempotency)", () => {
    let s = emptyState("+55a", NOW);
    expect(isProcessed(s, "m1")).toBe(false);
    s = markProcessed(s, "m1", NOW);
    s = markProcessed(s, "m1", NOW);
    expect(s.processedInboundIds).toEqual(["m1"]);
    expect(isProcessed(s, "m1")).toBe(true);
  });
});

describe("stripThinking — provider thinking blocks never reach the persisted state (004 R1)", async () => {
  const { stripThinking } = await import("../../src/agent/conversation");

  it("removes thinking blocks from every message and drops assistant messages left empty", () => {
    const s0 = emptyState("+55a", NOW);
    const s1 = {
      ...s0,
      history: [
        { role: "user" as const, content: [{ type: "text" as const, text: "oi" }] },
        {
          role: "assistant" as const,
          content: [
            { type: "thinking" as const, raw: { type: "thinking", thinking: "…", signature: "s" } },
            { type: "tool_use" as const, id: "tu", name: "get_availability", input: {} },
          ],
        },
        {
          role: "user" as const,
          content: [{ type: "tool_result" as const, toolUseId: "tu", content: "{}" }],
        },
        {
          role: "assistant" as const,
          content: [{ type: "thinking" as const, raw: { type: "redacted_thinking", data: "x" } }],
        },
      ],
    };
    const out = stripThinking(s1);
    expect(out.history).toEqual([
      { role: "user", content: [{ type: "text", text: "oi" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu", name: "get_availability", input: {} }],
      },
      { role: "user", content: [{ type: "tool_result", toolUseId: "tu", content: "{}" }] },
    ]);
    expect(s1.history).toHaveLength(4); // immutable
  });

  it("returns the same reference when there is nothing to strip", () => {
    const s = appendUserText(emptyState("+55a", NOW), "oi", NOW);
    expect(stripThinking(s)).toBe(s);
  });
});

describe("applyCommittedTurn — the status a replayed turn's committed writes imply (008)", () => {
  const base = emptyState("+55a", NOW);
  const w = (action: string, entityId: string | null = null) => ({ action, entityId });

  it("an escalation hands the conversation off, even after a booking in the same turn", () => {
    const s = applyCommittedTurn(base, [w("booking_confirmed", "b1"), w("escalated")], NOW);
    expect(s.status).toBe("escalated");
    expect(s.escalatedAt).toBe(NOW.toISOString());
  });

  it("a booking or a reschedule finishes it with the booking recorded", () => {
    expect(applyCommittedTurn(base, [w("booking_confirmed", "b1")], NOW)).toMatchObject({
      status: "completed",
      lastConfirmedBookingId: "b1",
    });
    const rescheduled = applyCommittedTurn(
      base,
      [w("booking_cancelled", "old"), w("booking_rescheduled", "new")],
      NOW,
    );
    expect(rescheduled).toMatchObject({ status: "completed", lastConfirmedBookingId: "new" });
  });

  it("a cancellation or an attendance confirmation finishes it", () => {
    expect(applyCommittedTurn(base, [w("booking_cancelled", "b1")], NOW).status).toBe("completed");
    expect(applyCommittedTurn(base, [w("attendance_confirmed", "b1")], NOW).status).toBe(
      "completed",
    );
  });

  it("nothing committed leaves the state as it was", () => {
    expect(applyCommittedTurn(base, [], NOW)).toBe(base);
  });
});

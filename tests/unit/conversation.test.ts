import { describe, expect, it } from "vitest";
import {
  appendUserText,
  emptyState,
  hasActiveHold,
  isOfferedSlot,
  isProcessed,
  markProcessed,
  recordConfirmed,
  recordHold,
  recordOfferedSlots,
} from "../../src/agent/conversation";

const NOW = new Date("2026-06-15T12:00:00Z");

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

  it("markProcessed dedups inbound ids (idempotency)", () => {
    let s = emptyState("+55a", NOW);
    expect(isProcessed(s, "m1")).toBe(false);
    s = markProcessed(s, "m1", NOW);
    s = markProcessed(s, "m1", NOW);
    expect(s.processedInboundIds).toEqual(["m1"]);
    expect(isProcessed(s, "m1")).toBe(true);
  });
});

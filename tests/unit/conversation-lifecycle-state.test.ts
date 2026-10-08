import { describe, expect, it } from "vitest";
import {
  boundState,
  emptyState,
  holdTurnOf,
  recordHoldTurn,
  recordSurfacedBooking,
  resetConversation,
  startTurn,
  surfacedTurnOf,
} from "../../src/agent/conversation";
import { ACTIVE_HOLDS_MAX, SURFACED_BOOKINGS_MAX } from "../../src/config";

// T603 (006) — the memory behind the `not_surfaced` and `confirmation_required` gates: which
// booking/hold the patient was shown, and in which inbound turn.

const NOW = new Date("2026-06-15T12:00:00Z");
const PHONE = "+5531900000601";

describe("turn counter", () => {
  it("a fresh conversation starts at turn 0 and every accepted inbound message advances it", () => {
    const s0 = emptyState(PHONE, NOW);
    expect(s0.turnSeq).toBe(0);
    const s1 = startTurn(s0, NOW);
    const s2 = startTurn(s1, NOW);
    expect([s1.turnSeq, s2.turnSeq]).toEqual([1, 2]);
    expect(s0.turnSeq).toBe(0); // pure
  });
});

describe("surfaced bookings", () => {
  it("records the turn in which find_my_booking showed a booking", () => {
    const s = recordSurfacedBooking(startTurn(emptyState(PHONE, NOW), NOW), "b1", NOW);
    expect(surfacedTurnOf(s, "b1")).toBe(1);
    expect(surfacedTurnOf(s, "other")).toBeNull();
  });

  it("keeps the FIRST turn a booking was shown in (showing it again does not reset the clock)", () => {
    let s = startTurn(emptyState(PHONE, NOW), NOW);
    s = recordSurfacedBooking(s, "b1", NOW);
    s = startTurn(s, NOW);
    s = recordSurfacedBooking(s, "b1", NOW);
    expect(surfacedTurnOf(s, "b1")).toBe(1);
    expect(s.surfacedBookings).toHaveLength(1);
  });

  it("is capped to the most recent SURFACED_BOOKINGS_MAX entries", () => {
    let s = startTurn(emptyState(PHONE, NOW), NOW);
    for (let i = 0; i < SURFACED_BOOKINGS_MAX + 3; i++) s = recordSurfacedBooking(s, `b${i}`, NOW);
    expect(s.surfacedBookings).toHaveLength(SURFACED_BOOKINGS_MAX);
    expect(surfacedTurnOf(s, "b0")).toBeNull();
    expect(surfacedTurnOf(s, `b${SURFACED_BOOKINGS_MAX + 2}`)).toBe(1);
  });
});

describe("hold turns", () => {
  it("records the turn in which hold_slot created a hold, once", () => {
    let s = startTurn(startTurn(emptyState(PHONE, NOW), NOW), NOW);
    s = recordHoldTurn(s, "h1", NOW);
    s = recordHoldTurn(startTurn(s, NOW), "h1", NOW);
    expect(holdTurnOf(s, "h1")).toBe(2);
    expect(holdTurnOf(s, "nope")).toBeNull();
    expect(s.holdSeqs).toHaveLength(1);
  });
});

describe("bounds and reset", () => {
  it("boundState caps hold turns like active holds and surfaced bookings to their max", () => {
    let s = startTurn(emptyState(PHONE, NOW), NOW);
    for (let i = 0; i < ACTIVE_HOLDS_MAX + 4; i++) {
      s = { ...s, holdSeqs: [...s.holdSeqs, { holdId: `h${i}`, turn: 1 }] };
    }
    for (let i = 0; i < SURFACED_BOOKINGS_MAX + 4; i++) {
      s = { ...s, surfacedBookings: [...s.surfacedBookings, { bookingId: `b${i}`, turn: 1 }] };
    }
    const b = boundState(s, NOW);
    expect(b.holdSeqs).toHaveLength(ACTIVE_HOLDS_MAX);
    expect(b.surfacedBookings).toHaveLength(SURFACED_BOOKINGS_MAX);
    expect(holdTurnOf(b, `h${ACTIVE_HOLDS_MAX + 3}`)).toBe(1);
  });

  it("boundState returns the same reference when nothing exceeds a bound", () => {
    const s = recordSurfacedBooking(startTurn(emptyState(PHONE, NOW), NOW), "b1", NOW);
    expect(boundState(s, NOW)).toBe(s);
  });

  it("a reset conversation forgets what was shown (a new conversation must look it up again)", () => {
    let s = startTurn(emptyState(PHONE, NOW), NOW);
    s = recordSurfacedBooking(s, "b1", NOW);
    s = recordHoldTurn(s, "h1", NOW);
    s = { ...s, version: 7 };
    const r = resetConversation(s, NOW);
    expect(r.surfacedBookings).toEqual([]);
    expect(r.holdSeqs).toEqual([]);
    expect(r.turnSeq).toBe(0);
    expect(r.version).toBe(7);
  });
});

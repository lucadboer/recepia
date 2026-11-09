import { describe, expect, it } from "vitest";
import { errorFeedback, toolFeedback } from "../../src/agent/tool-feedback";
import {
  BookingNotChangeableError,
  BookingNotFoundError,
  CalendarWriteError,
  HoldExpiredError,
  InvalidRescheduleError,
  OutOfScopeError,
  SlotOutOfWindowError,
  SlotUnavailableError,
} from "../../src/domain/errors";

// What the model reads back when a tool call fails (prompt v004: model-facing text is English).

describe("errorFeedback", () => {
  it("maps each tool error to a distinct, non-empty instruction for the model", () => {
    const errors = [
      new SlotUnavailableError(),
      new SlotOutOfWindowError(),
      new HoldExpiredError(),
      new OutOfScopeError("invisalign"),
      new CalendarWriteError(),
      new BookingNotFoundError(),
      new BookingNotChangeableError(),
      new InvalidRescheduleError("same_time"),
    ];
    const texts = errors.map(errorFeedback);
    for (const t of texts) expect(t.length).toBeGreaterThan(0);
    expect(new Set(texts).size).toBe(errors.length);
  });

  it("says what to do next: other times for a lost slot, the reception when out of scope", () => {
    expect(errorFeedback(new SlotUnavailableError())).toMatch(/other free times/);
    expect(errorFeedback(new SlotOutOfWindowError())).not.toMatch(/just taken/); // a window, not a race
    expect(errorFeedback(new OutOfScopeError("invisalign"))).toMatch(/reception/);
    expect(errorFeedback(new InvalidRescheduleError("different_type"))).toMatch(
      /different appointment type.*same appointment type/,
    );
  });

  it("falls back to a generic instruction for an unknown error", () => {
    expect(errorFeedback(new Error("boom"))).toMatch(/could not be completed/);
  });

  it("tells the model an action after the hand-off was not run", () => {
    expect(toolFeedback.cancelledAfterHandoff()).toMatch(/not run/);
  });
});

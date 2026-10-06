import { describe, expect, it } from "vitest";
import { errorReply, reply } from "../../src/agent/reply";
import {
  CalendarWriteError,
  HoldExpiredError,
  OutOfScopeError,
  SlotOutOfWindowError,
  SlotUnavailableError,
} from "../../src/domain/errors";

describe("reply (pt-BR error mapping)", () => {
  it("maps each tool error to a distinct non-empty pt-BR message", () => {
    const slot = errorReply(new SlotUnavailableError());
    const window = errorReply(new SlotOutOfWindowError());
    const expired = errorReply(new HoldExpiredError());
    const scope = errorReply(new OutOfScopeError("invisalign"));
    const cal = errorReply(new CalendarWriteError());
    for (const m of [slot, window, expired, scope, cal]) expect(m.length).toBeGreaterThan(0);
    expect(new Set([slot, window, expired, scope]).size).toBe(4); // all distinct
    expect(window).not.toContain("preenchido"); // not "just filled up" — it is out of the window
    expect(window.toLowerCase()).toContain("horário");
    expect(scope.toLowerCase()).toContain("recep"); // out-of-scope -> reception
  });

  it("hand-off notice is pt-BR, mentions reception, and differs from the escalation reply", () => {
    expect(reply.handedOff()).toContain("recepção");
    expect(reply.handedOff()).not.toBe(reply.escalatedToReception());
  });

  it("falls back to could-not-complete for unknown errors", () => {
    expect(errorReply(new Error("boom"))).toBe(reply.couldNotComplete());
  });
});

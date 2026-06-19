import { describe, expect, it } from "vitest";
import { errorReply, reply } from "../../src/agent/reply";
import {
  CalendarWriteError,
  HoldExpiredError,
  OutOfScopeError,
  SlotUnavailableError,
} from "../../src/domain/errors";

describe("reply (pt-BR error mapping)", () => {
  it("maps each tool error to a distinct non-empty pt-BR message", () => {
    const slot = errorReply(new SlotUnavailableError());
    const expired = errorReply(new HoldExpiredError());
    const scope = errorReply(new OutOfScopeError("invisalign"));
    const cal = errorReply(new CalendarWriteError());
    for (const m of [slot, expired, scope, cal]) expect(m.length).toBeGreaterThan(0);
    expect(slot).not.toBe(expired);
    expect(slot).not.toBe(scope);
    expect(scope.toLowerCase()).toContain("recep"); // out-of-scope -> reception
  });

  it("falls back to could-not-complete for unknown errors", () => {
    expect(errorReply(new Error("boom"))).toBe(reply.couldNotComplete());
  });
});

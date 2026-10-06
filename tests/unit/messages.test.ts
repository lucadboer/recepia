import { describe, expect, it } from "vitest";
import { confirmationMessagePt, formatSlotPt } from "../../src/messages";

describe("messages — patient-facing dates in the clinic's IANA timezone (FR-213)", () => {
  it("renders a UTC instant as DD/MM/YYYY às HH:MM in America/Sao_Paulo", () => {
    expect(formatSlotPt(new Date("2026-06-15T14:00:00Z"))).toBe("15/06/2026 às 11:00");
  });

  it("keeps the local date when UTC has rolled past midnight", () => {
    expect(formatSlotPt(new Date("2026-06-16T02:00:00Z"))).toBe("15/06/2026 às 23:00");
  });

  it("confirmation message is pt-BR with the type label and the local time", () => {
    const msg = confirmationMessagePt("cleaning", new Date("2026-06-15T14:00:00Z"));
    expect(msg).toContain("limpeza");
    expect(msg).toContain("15/06/2026 às 11:00");
  });
});

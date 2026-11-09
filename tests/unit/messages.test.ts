import { describe, expect, it } from "vitest";
import { confirmationMessagePt, formatSlotPt, friendlySlotPt } from "../../src/messages";

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
    expect(msg).toContain("segunda, 15/06, às 11h");
    expect(msg).toMatch(/confirmada/);
  });

  it("confirmation reads right when the appointment is for someone else (no 'sua consulta')", () => {
    expect(confirmationMessagePt("cleaning", new Date("2026-06-15T14:00:00Z"))).not.toMatch(
      /\bsua consulta\b/i,
    );
  });
});

describe("friendlySlotPt — how a person says the time in a chat", () => {
  it("weekday without '-feira', day/month, whole hours as '17h'", () => {
    expect(friendlySlotPt(new Date("2026-06-24T20:00:00Z"))).toBe("quarta, 24/06, às 17h");
  });

  it("half hours as '9h30', no leading zero", () => {
    expect(friendlySlotPt(new Date("2026-06-22T12:30:00Z"))).toBe("segunda, 22/06, às 9h30");
  });

  it("weekend names stay whole", () => {
    expect(friendlySlotPt(new Date("2026-06-27T13:00:00Z"))).toBe("sábado, 27/06, às 10h");
  });

  it("uses the clinic-local day when UTC has rolled past midnight", () => {
    expect(friendlySlotPt(new Date("2026-06-16T02:00:00Z"))).toBe("segunda, 15/06, às 23h");
  });
});

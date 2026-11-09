import { describe, expect, it } from "vitest";
import { toWhatsAppText } from "../../src/agent/text.ts";

describe("toWhatsAppText", () => {
  it("turns Markdown bold into WhatsApp bold (live reply, golden case date-06)", () => {
    expect(toWhatsAppText("**Segunda, 22/06:** 16h · 16h30\n**Quarta, 24/06:** 17h")).toBe(
      "*Segunda, 22/06:* 16h · 16h30\n*Quarta, 24/06:* 17h",
    );
    expect(toWhatsAppText("**Limpeza da Iara na quarta, 24/06 às 17h.**")).toBe(
      "*Limpeza da Iara na quarta, 24/06 às 17h.*",
    );
  });

  it("leaves text that is already WhatsApp formatting, or not formatting at all, alone", () => {
    for (const s of [
      "*já em negrito*",
      "Posso confirmar? (responda SIM)",
      "2 * 3 = 6",
      "** solto",
      "** com espaço **",
      "",
    ]) {
      expect(toWhatsAppText(s)).toBe(s);
    }
  });

  it("never joins bold across lines", () => {
    expect(toWhatsAppText("**sem fim\nna outra linha**")).toBe("**sem fim\nna outra linha**");
  });
});

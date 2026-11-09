import { describe, expect, it } from "vitest";
import { reply } from "../../src/agent/reply";

describe("reply (patient-facing pt-BR copy)", () => {
  it("hand-off notice is pt-BR, mentions reception, and differs from the escalation reply", () => {
    expect(reply.handedOff()).toContain("recepção");
    expect(reply.handedOff()).not.toBe(reply.escalatedToReception());
  });

  it("the consent request names the data and the purpose (LGPD) and asks for SIM", () => {
    const ask = reply.askConsent();
    expect(ask).toContain("nome e telefone");
    expect(ask).toContain("finalidade");
    expect(ask).toContain("SIM");
  });
});

import { describe, expect, it } from "vitest";
import { triage } from "../../src/agent/triage";

describe("triage — deterministic escalation signals (escalate-on-doubt)", () => {
  it.each([
    ["estou com muita dor de dente", "urgency"],
    ["é uma urgência, socorro", "urgency"],
    ["quero colocar Invisalign", "specialized_procedure"],
    ["preciso de um implante", "specialized_procedure"],
    ["vou fazer ortodontia", "specialized_procedure"],
    ["estou em tratamento, posso continuar?", "ongoing_treatment"],
    ["quero falar com o Dr. Souza", "specific_professional"],
    ["quero fazer uma reclamação", "complaint"],
    ["quanto custa a limpeza?", "financial"],
    ["vocês aceitam meu convênio?", "financial"],
    ["quero falar com um atendente", "human_requested"],
  ])("escalates %j -> %s", (text, reason) => {
    const r = triage(text);
    expect(r.escalate).toBe(true);
    expect(r.reason).toBe(reason);
  });

  it.each([
    ["quero marcar uma limpeza"],
    ["bom dia, gostaria de agendar uma avaliação"],
    ["pode ser amanhã de manhã?"],
    ["meu nome é João"],
  ])("does NOT escalate %j", (text) => {
    expect(triage(text).escalate).toBe(false);
  });

  // Per-regex-branch coverage so a single pattern can't regress unnoticed.
  it.each([
    ["está doendo muito", "urgency"],
    ["doi quando mastigo", "urgency"],
    ["minha gengiva está sangrando", "urgency"],
    ["meu rosto está inchado", "urgency"],
    ["preciso fazer canal", "specialized_procedure"],
    ["quero uma prótese", "specialized_procedure"],
    ["vou por aparelho", "specialized_procedure"],
    ["preciso de uma cirurgia", "specialized_procedure"],
    ["tenho que arrancar o siso", "specialized_procedure"],
    ["quero continuar o tratamento", "ongoing_treatment"],
    ["é sobre meu tratamento", "ongoing_treatment"],
    ["queria a doutora Marina", "specific_professional"],
    ["atende com a dra Paula", "specific_professional"],
    ["quero processar a clínica", "complaint"],
    ["o atendimento foi horrível", "complaint"],
    ["estou insatisfeito", "complaint"],
    ["foi péssimo", "complaint"],
    ["qual o valor", "financial"],
    ["meu plano cobre?", "financial"],
    ["posso parcelar?", "financial"],
    ["tem desconto?", "financial"],
    ["quero um orçamento", "financial"],
    ["como faço o pagamento", "financial"],
    ["quero falar com um humano", "human_requested"],
    ["me transfere pra recepção", "human_requested"],
  ])("branch: escalates %j -> %s", (text, reason) => {
    const r = triage(text);
    expect(r.escalate).toBe(true);
    expect(r.reason).toBe(reason);
  });
});

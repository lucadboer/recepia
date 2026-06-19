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
});

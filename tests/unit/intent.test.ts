import { describe, expect, it } from "vitest";
import { classifyIntent, isAffirmative } from "../../src/agent/intent";

describe("classifyIntent", () => {
  it.each([
    ["não quero mais receber mensagens", "opt_out"],
    ["quero descadastrar", "opt_out"],
    ["quero marcar uma limpeza", "booking"],
    ["gostaria de agendar uma avaliação", "booking"],
    ["bom dia", "greeting"],
    ["olá", "greeting"],
    ["sei lá, talvez", "other"],
  ] as const)("classifies %j -> %s", (text, intent) => {
    expect(classifyIntent(text)).toBe(intent);
  });

  it("prioritizes opt-out and booking over greeting", () => {
    expect(classifyIntent("oi, quero marcar uma consulta")).toBe("booking");
    expect(classifyIntent("oi, quero descadastrar")).toBe("opt_out");
  });
});

describe("isAffirmative — a negated reply is never consent (feature 004 golden set finding)", () => {
  it.each([
    ["Não autorizo.", false],
    ["nao concordo com isso", false],
    ["Nem pensar, claro que não", false],
    ["Jamais aceito", false],
    ["Recuso", false],
    ["Sim, autorizo", true],
    ["SIM", true],
    ["pode sim", true],
    ["Pensei melhor: SIM, autorizo.", true],
  ])("%j → %s", (text, expected) => {
    expect(isAffirmative(text)).toBe(expected);
  });
});

describe("isAffirmative — documented conservative case", () => {
  it('"Não, pode sim" is NOT consent (negation wins; the agent asks again)', () => {
    expect(isAffirmative("Não, pode sim")).toBe(false);
  });
});

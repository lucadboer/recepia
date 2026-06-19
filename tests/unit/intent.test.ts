import { describe, expect, it } from "vitest";
import { classifyIntent } from "../../src/agent/intent";

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

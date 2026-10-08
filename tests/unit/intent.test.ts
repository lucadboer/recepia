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

// T703 (007) — the reminder fast path confirms attendance only for an unmistakable "yes".
describe("isStrictAffirmative — a reply that is ONLY an affirmation", () => {
  it.each([
    "sim",
    "Sim!",
    "SIM.",
    "  sim  ",
    "confirmo",
    "Confirmado",
    "pode confirmar",
    "sim, confirmo",
    "sim confirmo",
    "ok",
    "Ok!",
    "👍",
    "estarei lá",
    "vou sim",
    "Confirmar presença", // the reminder template's quick-reply button
  ])("accepts %j", async (text) => {
    const { isStrictAffirmative } = await import("../../src/agent/intent");
    expect(isStrictAffirmative(text)).toBe(true);
  });

  it.each([
    "sim, mas preciso mudar o horário",
    "sim? que horas mesmo?",
    "não",
    "não vou poder ir",
    "sim não sei",
    "talvez",
    "ok, mas quero remarcar",
    "pode cancelar",
    "sim, pode cancelar",
    "",
    "quero confirmar minha presença na consulta de amanhã e também marcar outra para minha filha",
  ])("rejects %j", async (text) => {
    const { isStrictAffirmative } = await import("../../src/agent/intent");
    expect(isStrictAffirmative(text)).toBe(false);
  });
});

describe("opt-out is not fooled by an appointment (007 FR-708)", () => {
  it("'me tira da lista' still opts out; 'me tira dessa consulta' does not", async () => {
    const { classifyIntent } = await import("../../src/agent/intent");
    expect(classifyIntent("me tira da lista, por favor")).toBe("opt_out");
    expect(classifyIntent("me tira daqui")).toBe("opt_out");
    expect(classifyIntent("Me tira!")).toBe("opt_out");
    expect(classifyIntent("  me tira  ")).toBe("opt_out");
    expect(classifyIntent("Me tira, por favor.")).toBe("opt_out");
    expect(classifyIntent("me tira dessa consulta, não vou poder ir")).not.toBe("opt_out");
    expect(classifyIntent("pode me tirar do horário de amanhã?")).not.toBe("opt_out");
  });
});

describe("isChangeRequest (007 review)", () => {
  it.each([
    "sim, mas preciso mudar o horário",
    "quero remarcar",
    "não vou poder ir",
    "pode cancelar",
    "outro dia",
  ])("%j asks for a change", async (t) => {
    const { isChangeRequest } = await import("../../src/agent/intent");
    expect(isChangeRequest(t)).toBe(true);
  });
  it.each(["sim, estarei lá", "confirmo minha presença", "ok, até amanhã"])(
    "%j does not",
    async (t) => {
      const { isChangeRequest } = await import("../../src/agent/intent");
      expect(isChangeRequest(t)).toBe(false);
    },
  );
});

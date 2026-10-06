import { describe, expect, it } from "vitest";
import { SUMMARY_MAX_CHARS, SUMMARY_MAX_LINES, summarizeHistory } from "../../src/agent/summary";
import type { LlmMessage } from "../../src/ports/llm-port";

const user = (text: string): LlmMessage => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string): LlmMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

describe("summarizeHistory — deterministic excerpt for reception (T236, FR-204)", () => {
  it("returns an empty list for an empty history", () => {
    expect(summarizeHistory([])).toEqual([]);
  });

  it("labels roles in pt-BR and keeps chronological order", () => {
    const out = summarizeHistory([
      user("quero marcar"),
      assistant("claro, qual dia?"),
      user("amanhã"),
    ]);
    expect(out).toEqual([
      "Paciente: quero marcar",
      "Assistente: claro, qual dia?",
      "Paciente: amanhã",
    ]);
  });

  it("skips tool_use / tool_result blocks and messages with no text", () => {
    const history: LlmMessage[] = [
      user("oi"),
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu1", name: "get_availability", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "tu1", content: '{"slots":[]}' }],
      },
      assistant("não há horários"),
    ];
    expect(summarizeHistory(history)).toEqual(["Paciente: oi", "Assistente: não há horários"]);
  });

  it("keeps only the last SUMMARY_MAX_LINES lines", () => {
    const history = Array.from({ length: SUMMARY_MAX_LINES + 4 }, (_, i) => user(`m${i}`));
    const out = summarizeHistory(history);
    expect(out).toHaveLength(SUMMARY_MAX_LINES);
    expect(out.at(-1)).toBe(`Paciente: m${SUMMARY_MAX_LINES + 3}`);
    expect(out[0]).toBe("Paciente: m4");
  });

  it("truncates long lines to SUMMARY_MAX_CHARS with an ellipsis and collapses whitespace", () => {
    const long = "a".repeat(SUMMARY_MAX_CHARS + 50);
    const [line] = summarizeHistory([user(long)]);
    expect(line.startsWith("Paciente: ")).toBe(true);
    expect(line.endsWith("…")).toBe(true);
    expect(line.length).toBe("Paciente: ".length + SUMMARY_MAX_CHARS);
    expect(summarizeHistory([user("oi \n\n  tudo   bem")])).toEqual(["Paciente: oi tudo bem"]);
  });

  it("joins multiple text blocks of one message into a single line", () => {
    const m: LlmMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "Posso ajudar." },
        { type: "text", text: "Qual dia prefere?" },
      ],
    };
    expect(summarizeHistory([m])).toEqual(["Assistente: Posso ajudar. Qual dia prefere?"]);
  });
});

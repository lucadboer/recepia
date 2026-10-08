// Deterministic conversation excerpt for reception hand-offs (FR-204). Pure, no LLM:
// the summary must be reproducible and must never be a place where the model can
// inject text that reception would trust.

import type { LlmMessage } from "../ports/llm-port.ts";

export const SUMMARY_MAX_LINES = 6;
export const SUMMARY_MAX_CHARS = 160;

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * The last `max` patient/assistant TEXT lines of the transcript, labelled in pt-BR
 * ("Paciente: …" / "Assistente: …"). Tool blocks and text-less messages are skipped;
 * whitespace is collapsed; each line is truncated to `maxChars`.
 */
export function summarizeHistory(
  history: LlmMessage[],
  max = SUMMARY_MAX_LINES,
  maxChars = SUMMARY_MAX_CHARS,
): string[] {
  const lines: string[] = [];
  for (const m of history) {
    const text = m.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length === 0) continue;
    const label = m.role === "user" ? "Paciente" : "Assistente";
    lines.push(`${label}: ${truncate(text, maxChars)}`);
  }
  return lines.length > max ? lines.slice(lines.length - max) : lines;
}

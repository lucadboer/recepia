// Optional LLM-as-judge (FR-410): tone and clarity of the patient-facing replies only, scored
// with a rubric versioned in the repository by a model DIFFERENT from the one under test.
// Reported separately; never a gate; any failure is "invalid", never an exception.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { LLMPort } from "../../src/ports/llm-port";
import type { TranscriptLine } from "./runner";

export const RUBRIC_PATH = fileURLToPath(new URL("../judge/rubric.v1.md", import.meta.url));
export const DEFAULT_JUDGE_MODEL = "claude-opus-5-5";
const FALLBACK_JUDGE_MODEL = "claude-sonnet-5-5";

export interface Rubric {
  version: string;
  text: string;
}

export interface Verdict {
  tone: number;
  clarity: number;
  justification: string;
}

export type JudgeResult =
  | ({ status: "scored"; rubricVersion: string } & Verdict)
  | { status: "invalid"; rubricVersion: string }
  | { status: "not_applicable"; rubricVersion: string }
  /** The spend cap was reached before this transcript could be judged. */
  | { status: "skipped"; rubricVersion: string };

export function loadRubric(path = RUBRIC_PATH): Rubric {
  const version = /rubric\.(v\d+)\.md$/.exec(path)?.[1];
  if (!version) throw new Error(`${path}: rubric file must be named rubric.vN.md`);
  return { version, text: readFileSync(path, "utf8") };
}

/** The judge must not be the model under test (self-preference); explicit requests are checked. */
export function judgeModelFor(modelUnderTest: string, requested?: string): string {
  if (requested !== undefined) {
    if (requested === modelUnderTest)
      throw new Error(
        `judge model must be different from the model under test (${modelUnderTest})`,
      );
    return requested;
  }
  return modelUnderTest === DEFAULT_JUDGE_MODEL ? FALLBACK_JUDGE_MODEL : DEFAULT_JUDGE_MODEL;
}

export function buildJudgePrompt(rubric: Rubric, transcript: TranscriptLine[]): string {
  const lines = transcript
    .filter((l) => l.role !== "reception")
    .map((l) => `${l.role === "patient" ? "Paciente" : "Assistente"}: ${l.text}`);
  return [
    rubric.text.trim(),
    "",
    "## Conversa (avalie apenas as falas da Assistente; as do Paciente são contexto)",
    "",
    ...lines,
    "",
    'Responda somente com o JSON: {"tone": <1-5>, "clarity": <1-5>, "justification": "<uma linha>"}',
  ].join("\n");
}

const isScore = (v: unknown): v is number =>
  Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 5;

export function parseVerdict(text: string): Verdict | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced ? fenced[1] : text).trim();
  const braces = /\{[\s\S]*\}/.exec(candidate);
  if (!braces) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(braces[0]);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const v = parsed as Record<string, unknown>;
  if (!isScore(v.tone) || !isScore(v.clarity) || typeof v.justification !== "string") return null;
  return { tone: v.tone, clarity: v.clarity, justification: v.justification };
}

export async function judgeTranscript(
  llm: LLMPort,
  rubric: Rubric,
  transcript: TranscriptLine[],
): Promise<JudgeResult> {
  if (!transcript.some((l) => l.role === "agent"))
    return { status: "not_applicable", rubricVersion: rubric.version };
  try {
    const res = await llm.turn({
      system:
        "Você é um avaliador imparcial de atendimento ao paciente. Siga a rubrica e responda apenas com JSON.",
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: buildJudgePrompt(rubric, transcript) }] },
      ],
    });
    const text = res.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    const verdict = parseVerdict(text);
    if (!verdict) return { status: "invalid", rubricVersion: rubric.version };
    return { status: "scored", rubricVersion: rubric.version, ...verdict };
  } catch {
    return { status: "invalid", rubricVersion: rubric.version };
  }
}

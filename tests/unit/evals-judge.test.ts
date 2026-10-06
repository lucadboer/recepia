import { describe, expect, it } from "vitest";
import {
  buildJudgePrompt,
  DEFAULT_JUDGE_MODEL,
  judgeModelFor,
  judgeTranscript,
  loadRubric,
  parseVerdict,
  RUBRIC_PATH,
} from "../../evals/lib/judge";
import type { TranscriptLine } from "../../evals/lib/runner";
import type { LLMPort } from "../../src/ports/llm-port";

// T447 — the optional judge: versioned rubric, different model, defensive parsing, never a gate.

const transcript: TranscriptLine[] = [
  { role: "patient", text: "Oi, quero marcar uma limpeza amanhã." },
  { role: "agent", text: "Claro! Tenho amanhã às 09:00 ou 09:30. Qual prefere?" },
  { role: "reception", text: "Atendimento encaminhado à recepção." },
];

const llmSaying = (answer: string): LLMPort & { calls: number } => {
  const port = {
    calls: 0,
    async turn() {
      port.calls++;
      return {
        stopReason: "end_turn" as const,
        content: [{ type: "text" as const, text: answer }],
      };
    },
  };
  return port;
};

describe("rubric", () => {
  it("loads evals/judge/rubric.v1.md with a version derived from the file name", () => {
    const rubric = loadRubric();
    expect(RUBRIC_PATH).toMatch(/rubric\.v1\.md$/);
    expect(rubric.version).toBe("v1");
    expect(rubric.text).toMatch(/tom/i);
    expect(rubric.text).toMatch(/clareza/i);
  });

  it("buildJudgePrompt contains the rubric, only the AGENT replies and the JSON instruction", () => {
    const prompt = buildJudgePrompt({ version: "v1", text: "RUBRICA" }, transcript);
    expect(prompt).toContain("RUBRICA");
    expect(prompt).toContain("Tenho amanhã às 09:00");
    expect(prompt).toContain("quero marcar uma limpeza"); // patient context is shown
    expect(prompt).not.toContain("Atendimento encaminhado"); // reception messages are not judged
    expect(prompt).toMatch(/JSON/);
  });
});

describe("parseVerdict", () => {
  it("accepts a valid JSON verdict (also inside a code fence) and clamps to 1–5 integers", () => {
    expect(parseVerdict('{"tone": 4, "clarity": 5, "justification": "ok"}')).toEqual({
      tone: 4,
      clarity: 5,
      justification: "ok",
    });
    expect(parseVerdict('```json\n{"tone": 3, "clarity": 2, "justification": "meh"}\n```')).toEqual(
      {
        tone: 3,
        clarity: 2,
        justification: "meh",
      },
    );
    expect(parseVerdict('{"tone": 9, "clarity": 0, "justification": "x"}')).toBeNull();
    expect(parseVerdict('{"tone": 4.5, "clarity": 2, "justification": "x"}')).toBeNull();
  });

  it("returns null for unparsable or incomplete answers", () => {
    expect(parseVerdict("not json")).toBeNull();
    expect(parseVerdict('{"tone": 4}')).toBeNull();
    expect(parseVerdict("")).toBeNull();
  });
});

describe("judge model", () => {
  it("defaults to a model different from the one under test and refuses the same model", () => {
    expect(DEFAULT_JUDGE_MODEL).toBe("claude-opus-5-5");
    expect(judgeModelFor("claude-sonnet-5-5")).toBe("claude-opus-5-5");
    expect(judgeModelFor("claude-opus-5-5")).toBe("claude-sonnet-5-5");
    expect(() => judgeModelFor("claude-sonnet-5-5", "claude-sonnet-5-5")).toThrow(/different/);
    expect(judgeModelFor("claude-sonnet-5-5", "claude-haiku-4-5")).toBe("claude-haiku-4-5");
  });
});

describe("judgeTranscript", () => {
  it("returns the scores with the rubric version; an unparsable answer → invalid, no throw", async () => {
    const good = llmSaying('{"tone": 5, "clarity": 4, "justification": "cordial e direto"}');
    const res = await judgeTranscript(good, { version: "v1", text: "R" }, transcript);
    expect(res).toEqual({
      status: "scored",
      rubricVersion: "v1",
      tone: 5,
      clarity: 4,
      justification: "cordial e direto",
    });
    expect(good.calls).toBe(1);

    const bad = llmSaying("não sei");
    expect(await judgeTranscript(bad, { version: "v1", text: "R" }, transcript)).toEqual({
      status: "invalid",
      rubricVersion: "v1",
    });
  });

  it("a transcript without agent replies is not judged", async () => {
    const llm = llmSaying("{}");
    const res = await judgeTranscript(llm, { version: "v1", text: "R" }, [
      { role: "patient", text: "oi" },
    ]);
    expect(res).toEqual({ status: "not_applicable", rubricVersion: "v1" });
    expect(llm.calls).toBe(0);
  });

  it("a provider error is reported as invalid, never thrown (the judge is not a gate)", async () => {
    const llm: LLMPort = {
      async turn() {
        throw new Error("529 overloaded");
      },
    };
    expect(await judgeTranscript(llm, { version: "v1", text: "R" }, transcript)).toEqual({
      status: "invalid",
      rubricVersion: "v1",
    });
  });
});

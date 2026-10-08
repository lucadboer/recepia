import type {
  LLMPort,
  LlmContent,
  LlmTurnInput,
  LlmTurnResult,
  LlmUsage,
} from "../../ports/llm-port.ts";

/** Fakes cost nothing; the shape matches the real adapter so metrics code has one path. */
export const ZERO_USAGE: LlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** A scripted turn: a fixed result, or a function that branches on the turn input. */
export type ScriptedTurn = LlmTurnResult | ((input: LlmTurnInput) => LlmTurnResult);

export function text(t: string): LlmContent {
  return { type: "text", text: t };
}

export function toolUse(name: string, input: unknown, id = `tu_${name}`): LlmContent {
  return { type: "tool_use", id, name, input };
}

export function toolUseTurn(...blocks: LlmContent[]): LlmTurnResult {
  return { stopReason: "tool_use", content: blocks };
}

export function finalTurn(t: string): LlmTurnResult {
  return { stopReason: "end_turn", content: [text(t)] };
}

/**
 * Deterministic, scriptable LLM for behavioral tests. The fake decides which tool
 * to call — including hostile/hallucinated calls — which is exactly how we prove
 * the orchestrator's structural guardrails hold regardless of model behavior.
 */
export class FakeLLM implements LLMPort {
  readonly receivedInputs: LlmTurnInput[] = [];
  readonly model: string = "scripted";
  readonly provider: string = "fake";
  private index = 0;

  constructor(private readonly script: ScriptedTurn[]) {}

  async turn(input: LlmTurnInput): Promise<LlmTurnResult> {
    this.receivedInputs.push(input);
    const next = this.script[this.index++];
    if (next === undefined) {
      throw new Error(`FakeLLM: script exhausted after ${this.index - 1} turn(s)`);
    }
    const result = typeof next === "function" ? next(input) : next;
    return { usage: ZERO_USAGE, ...result };
  }

  get callCount(): number {
    return this.receivedInputs.length;
  }
}

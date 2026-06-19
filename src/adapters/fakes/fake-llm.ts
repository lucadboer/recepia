import type { LLMPort, LlmContent, LlmTurnInput, LlmTurnResult } from "../../ports/llm-port";

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
  private index = 0;

  constructor(private readonly script: ScriptedTurn[]) {}

  async turn(input: LlmTurnInput): Promise<LlmTurnResult> {
    this.receivedInputs.push(input);
    const next = this.script[this.index++];
    if (next === undefined) {
      throw new Error(`FakeLLM: script exhausted after ${this.index - 1} turn(s)`);
    }
    return typeof next === "function" ? next(input) : next;
  }

  get callCount(): number {
    return this.receivedInputs.length;
  }
}

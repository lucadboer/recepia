// Provider-neutral LLM tool-use port. One `turn` mirrors a single Anthropic
// Messages API exchange: given history + tool defs, the model returns tool_use
// block(s) or a final text. Keeps the Anthropic SDK out of src/agent.

export interface LlmToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
}

export type LlmContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean };

export interface LlmMessage {
  role: "user" | "assistant";
  content: LlmContent[];
}

export interface LlmTurnInput {
  system: string;
  tools: LlmToolDef[];
  messages: LlmMessage[];
}

export interface LlmTurnResult {
  stopReason: "tool_use" | "end_turn" | "max_tokens";
  content: LlmContent[];
}

export interface LLMPort {
  turn(input: LlmTurnInput): Promise<LlmTurnResult>;
}

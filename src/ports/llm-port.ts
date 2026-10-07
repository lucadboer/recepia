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
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean }
  /**
   * An opaque provider reasoning block (`thinking` / `redacted_thinking`). It is replayed
   * UNCHANGED within the inbound turn that produced it (the provider verifies its signature
   * against an unedited prefix) and stripped before the conversation state is persisted,
   * because the history is edited between inbound turns (dated prompt line, trimming).
   */
  | { type: "thinking"; raw: unknown };

export interface LlmMessage {
  role: "user" | "assistant";
  content: LlmContent[];
}

export interface LlmTurnInput {
  system: string;
  tools: LlmToolDef[];
  messages: LlmMessage[];
  /** Version id of the system prompt artifact in effect (FR-409). Never sent to the provider. */
  promptVersion?: string;
  /**
   * Length of the stable prefix of `system` (static instructions). Adapters that support it
   * mark that prefix as cacheable; the rest (the dated line) changes per turn (005 FR-511).
   */
  systemCacheablePrefix?: number;
}

/** Token accounting as reported by the provider; fakes report zeros. */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LlmTurnResult {
  /**
   * `refusal`: the provider's safety layer declined; any tool_use in `content` must NOT run.
   * `max_tokens`: output was cut; a tool_use in `content` may carry a truncated input.
   */
  stopReason: "tool_use" | "end_turn" | "max_tokens" | "refusal";
  content: LlmContent[];
  usage?: LlmUsage;
  /** Provider detail for a refusal (category / explanation), when reported. */
  stopDetails?: { category: string | null; explanation: string | null };
  /** The model that actually answered (may differ from the requested one after a fallback). */
  model?: string;
  /** Who served the call: "anthropic", "openai-compatible", "fake", … */
  provider?: string;
}

export interface LLMPort {
  turn(input: LlmTurnInput): Promise<LlmTurnResult>;
  /** Requested model, when the adapter knows it (telemetry span name, budget pricing). */
  readonly model?: string;
  readonly provider?: string;
}

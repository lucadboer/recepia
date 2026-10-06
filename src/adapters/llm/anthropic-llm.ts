import Anthropic from "@anthropic-ai/sdk";
import { NotConfigured } from "../../domain/errors";
import type {
  LLMPort,
  LlmContent,
  LlmMessage,
  LlmTurnInput,
  LlmTurnResult,
  LlmUsage,
} from "../../ports/llm-port";

/** Production model (owner decision 2026-10-06, feature 004 R1). Measured by the eval harness. */
export const DEFAULT_MODEL = "claude-sonnet-5-5";
// Replies are a few sentences and tool inputs are tiny; `between_tools` adds only short
// progress notes, so this budget is generous without inviting long outputs.
const MAX_TOKENS = 4096;

/** The subset of the SDK client the adapter uses — injectable for unit tests (no network). */
export interface MessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export interface AnthropicLLMOptions {
  /** Defaults to ANTHROPIC_API_KEY. Required unless `client` is injected. */
  apiKey?: string;
  /** Defaults to ANTHROPIC_MODEL, then DEFAULT_MODEL. */
  model?: string;
  /** Test seam: a stubbed client; skips the key requirement. */
  client?: MessagesClient;
}

export type RequestTuning = Pick<
  Anthropic.MessageCreateParamsNonStreaming,
  "thinking" | "output_config"
>;

/**
 * Per-model request knobs. The port asks for short, tool-driven answers, so thinking is
 * kept to the minimum each model allows:
 *  - claude-sonnet-5-5: `between_tools` is the lowest setting (`disabled` 400s) and is
 *    accepted only on this model; effort `low` (must be <= high with between_tools).
 *  - Claude 5 family (sonnet-5, opus-5*, fable, mythos): thinking is on by default and
 *    cannot be turned off everywhere; `output_config.effort: low` keeps it short.
 *  - Older models (4.x): thinking is off unless requested; send nothing extra.
 * Pure, so a router/eval run that switches models never re-sends a rejected field.
 */
export function requestTuningFor(model: string): RequestTuning {
  if (/^claude-sonnet-5-5/.test(model)) {
    return { thinking: { type: "between_tools" }, output_config: { effort: "low" } };
  }
  if (/^claude-(sonnet-5|opus-5|fable|mythos)/.test(model)) {
    return { output_config: { effort: "low" } };
  }
  return {};
}

/**
 * Real Anthropic tool-use adapter. Maps the provider-neutral LLMPort onto the Messages API.
 * Thinking/progress blocks are carried opaquely (`{ type: "thinking", raw }`) and passed
 * back byte-for-byte within a turn; the orchestrator strips them before persisting.
 * `tool_choice` is never forced (400 on the production model); schemas are `strict`.
 *
 * Credentials/model come from the env (NEEDS-USER):
 *   - ANTHROPIC_API_KEY (required) — fail fast with NotConfigured if absent
 *   - ANTHROPIC_MODEL (optional)   — defaults to DEFAULT_MODEL
 */
export class AnthropicLLM implements LLMPort {
  private readonly client: MessagesClient;
  private readonly model: string;

  constructor(opts: AnthropicLLMOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    const model = opts.model ?? process.env.ANTHROPIC_MODEL;
    if (!opts.client && !apiKey) {
      throw new NotConfigured("AnthropicLLM: ANTHROPIC_API_KEY not set (NEEDS-USER)");
    }
    this.client = opts.client ?? new Anthropic({ apiKey });
    this.model = model && model.length > 0 ? model : DEFAULT_MODEL;
  }

  async turn(input: LlmTurnInput): Promise<LlmTurnResult> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: MAX_TOKENS,
      ...requestTuningFor(this.model),
      system: input.system,
      tools: input.tools.map(
        (t): Anthropic.Tool => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
          strict: true,
        }),
      ),
      messages: toMessageParams(input.messages),
    });

    return {
      stopReason: mapStopReason(response.stop_reason),
      content: fromResponseContent(response.content),
      usage: mapUsage(response.usage),
    };
  }
}

function toMessageParams(messages: LlmMessage[]): Anthropic.MessageParam[] {
  return messages.map((m) => ({ role: m.role, content: toBlockParams(m.content) }));
}

function toBlockParams(content: LlmContent[]): Anthropic.ContentBlockParam[] {
  return content.map((c): Anthropic.ContentBlockParam => {
    switch (c.type) {
      case "text":
        return { type: "text", text: c.text };
      case "tool_use":
        return { type: "tool_use", id: c.id, name: c.name, input: c.input };
      case "tool_result":
        return {
          type: "tool_result",
          tool_use_id: c.toolUseId,
          content: c.content,
          is_error: c.isError,
        };
      case "thinking":
        // Exactly as received (signature intact) — a re-shaped block is a 400.
        return c.raw as Anthropic.ContentBlockParam;
      default:
        throw new Error("unreachable: unknown LlmContent type");
    }
  });
}

function fromResponseContent(content: Anthropic.ContentBlock[]): LlmContent[] {
  const out: LlmContent[] = [];
  for (const block of content) {
    if (block.type === "text") {
      out.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      out.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
    } else if (block.type === "thinking" || block.type === "redacted_thinking") {
      out.push({ type: "thinking", raw: block });
    }
    // Server-tool blocks etc. are never requested here and are ignored.
  }
  return out;
}

function mapStopReason(reason: Anthropic.StopReason | null): LlmTurnResult["stopReason"] {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "end_turn";
  }
}

function mapUsage(usage: Anthropic.Usage): LlmUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

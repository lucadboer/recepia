import Anthropic from "@anthropic-ai/sdk";
import { NotConfigured } from "../../domain/errors";
import type {
  LLMPort,
  LlmContent,
  LlmMessage,
  LlmTurnInput,
  LlmTurnResult,
} from "../../ports/llm-port";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 4096;

/**
 * Real Anthropic tool-use adapter. Maps the provider-neutral LLMPort onto the
 * Messages API. Thinking is intentionally NOT enabled: the orchestrator persists
 * only text/tool_use/tool_result blocks in conversation state, so omitting thinking
 * keeps the multi-turn round-trip clean (no thinking blocks to echo back).
 *
 * Credentials/model come from the env (NEEDS-USER):
 *   - ANTHROPIC_API_KEY (required) — fail fast with NotConfigured if absent
 *   - ANTHROPIC_MODEL (optional)   — defaults to claude-sonnet-4-6
 */
export class AnthropicLLM implements LLMPort {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(apiKey = process.env.ANTHROPIC_API_KEY, model = process.env.ANTHROPIC_MODEL) {
    if (!apiKey) {
      throw new NotConfigured("AnthropicLLM: ANTHROPIC_API_KEY not set (NEEDS-USER)");
    }
    this.client = new Anthropic({ apiKey });
    this.model = model && model.length > 0 ? model : DEFAULT_MODEL;
  }

  async turn(input: LlmTurnInput): Promise<LlmTurnResult> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: MAX_TOKENS,
      system: input.system,
      tools: input.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      })),
      messages: toMessageParams(input.messages),
    });

    return {
      stopReason: mapStopReason(response.stop_reason),
      content: fromResponseContent(response.content),
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
    }
    // Other block types (e.g. thinking) are not produced here and are ignored.
  }
  return out;
}

function mapStopReason(reason: string | null): LlmTurnResult["stopReason"] {
  if (reason === "tool_use") return "tool_use";
  if (reason === "max_tokens") return "max_tokens";
  return "end_turn";
}

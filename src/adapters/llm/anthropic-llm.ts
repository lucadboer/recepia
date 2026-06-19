import { NotConfigured } from "../../domain/errors";
import type { LLMPort, LlmTurnInput, LlmTurnResult } from "../../ports/llm-port";

/**
 * Real Anthropic tool-use adapter — SCAFFOLD. Compiles and satisfies LLMPort, but
 * the live API call sits behind a needs-creds boundary and is NEEDS-USER:
 *   - ANTHROPIC_API_KEY (secret)
 *   - model id + params: DO NOT guess — see the `claude-api` skill.
 */
export class AnthropicLLM implements LLMPort {
  constructor(apiKey = process.env.ANTHROPIC_API_KEY) {
    if (!apiKey) {
      throw new NotConfigured("AnthropicLLM: ANTHROPIC_API_KEY not set (NEEDS-USER)");
    }
  }

  async turn(_input: LlmTurnInput): Promise<LlmTurnResult> {
    // NEEDS-CREDS BOUNDARY — map LlmTurnInput -> Anthropic messages.create({ model, system,
    // tools, messages }) and the response (tool_use/text blocks) back to LlmTurnResult.
    // TODO(NEEDS-USER): pick the model id via the `claude-api` skill; wire the SDK call.
    throw new NotConfigured(
      "AnthropicLLM: live call not wired — model id + SDK pending (NEEDS-USER)",
    );
  }
}

import { describe, expect, it } from "vitest";
import { AnthropicLLM } from "../../src/adapters/llm/anthropic-llm";
import { toolDefs } from "../../src/agent/tool-schemas";

// LIVE smoke test — hits the real Anthropic Messages API. Out of the default
// `pnpm test` (excluded in vitest.config). Run with:
//   LIVE_LLM=1 pnpm test:live
// Requires ANTHROPIC_API_KEY (and optionally ANTHROPIC_MODEL) in .env.
const live = process.env.LIVE_LLM === "1";

describe.skipIf(!live)("AnthropicLLM — LIVE smoke test", () => {
  it("returns content from a single real turn()", async () => {
    const llm = new AnthropicLLM();
    const res = await llm.turn({
      system: "Responda em português, de forma breve.",
      tools: toolDefs,
      messages: [{ role: "user", content: [{ type: "text", text: "Diga apenas: olá" }] }],
    });

    expect(["tool_use", "end_turn", "max_tokens"]).toContain(res.stopReason);
    expect(res.content.length).toBeGreaterThan(0);
  });
});

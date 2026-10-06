import { describe, expect, it } from "vitest";
import { AnthropicLLM, DEFAULT_MODEL } from "../../src/adapters/llm/anthropic-llm";
import { buildSystemPrompt } from "../../src/agent/system-prompt";
import { TOOL_NAMES, toolDefs } from "../../src/agent/tool-schemas";
import { CLINIC_TIMEZONE } from "../../src/config";
import type { LlmMessage } from "../../src/ports/llm-port";

// LIVE smoke test — hits the real Anthropic Messages API. Out of the default
// `pnpm test` (excluded in vitest.config). Run with:
//   LIVE_LLM=1 pnpm test:live
// Requires ANTHROPIC_API_KEY (and optionally ANTHROPIC_MODEL) in .env.
const live = process.env.LIVE_LLM === "1";

describe.skipIf(!live)("AnthropicLLM — LIVE smoke test", () => {
  it("returns content and usage from a single real turn()", async () => {
    const llm = new AnthropicLLM();
    const res = await llm.turn({
      system: "Responda em português, de forma breve.",
      tools: toolDefs,
      messages: [{ role: "user", content: [{ type: "text", text: "Diga apenas: olá" }] }],
    });

    expect(["tool_use", "end_turn", "max_tokens", "refusal"]).toContain(res.stopReason);
    expect(res.content.length).toBeGreaterThan(0);
    expect(res.usage?.inputTokens).toBeGreaterThan(0);
    expect(res.usage?.outputTokens).toBeGreaterThan(0);
  });

  // T408 (004 R1): on the production model the request shape (between_tools + effort low +
  // strict tools) is accepted, the model reaches for get_availability on a booking request,
  // and the returned blocks (incl. any thinking/progress block) are accepted when replayed
  // UNCHANGED with the tool_result in the same turn.
  it("drives a tool-use round trip on the production model, replaying thinking blocks", async () => {
    const llm = new AnthropicLLM();
    const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
    const prompt = buildSystemPrompt({ now: new Date(), timezone: CLINIC_TIMEZONE });
    const history: LlmMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Oi! Quero marcar uma limpeza amanhã de manhã." }],
      },
    ];
    const first = await llm.turn({
      system: prompt.text,
      tools: toolDefs,
      messages: history,
      promptVersion: prompt.version,
    });
    expect(first.stopReason).not.toBe("refusal");
    const toolUse = first.content.find((c) => c.type === "tool_use");
    if (toolUse?.type !== "tool_use") {
      // A plain clarifying question is a legitimate first move; the round trip is then moot.
      console.warn(`[live] ${model}: no tool_use on the first turn (stop=${first.stopReason})`);
      return;
    }
    expect(toolUse.name).toBe(TOOL_NAMES.availability);
    history.push({ role: "assistant", content: first.content });
    history.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: toolUse.id,
          content: JSON.stringify({ slots: [], truncated: false }),
          isError: false,
        },
      ],
    });
    // Must not throw: thinking blocks (if any) go back exactly as received.
    const second = await llm.turn({
      system: prompt.text,
      tools: toolDefs,
      messages: history,
      promptVersion: prompt.version,
    });
    expect(["tool_use", "end_turn", "max_tokens"]).toContain(second.stopReason);
    expect(second.content.length).toBeGreaterThan(0);
    console.info(
      `[live] ${model}: first=${first.stopReason} thinkingBlocks=${first.content.filter((c) => c.type === "thinking").length} second=${second.stopReason} usage=${JSON.stringify(second.usage)}`,
    );
  }, 60_000);
});

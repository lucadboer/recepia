import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AnthropicLLM,
  DEFAULT_MODEL,
  type MessagesClient,
  requestTuningFor,
} from "../../src/adapters/llm/anthropic-llm";
import { toolDefs } from "../../src/agent/tool-schemas";
import { NotConfigured } from "../../src/domain/errors";
import type { LlmTurnInput } from "../../src/ports/llm-port";

// T403 — the adapter is unit-tested by stubbing the SDK client: no network, no key.
// What is asserted is the REQUEST SHAPE the production model needs (research R1) and the
// mapping of the RESPONSE onto the provider-neutral port.

type CreateParams = Anthropic.MessageCreateParamsNonStreaming;

function stubClient(responses: Anthropic.Message[]): {
  client: MessagesClient;
  calls: CreateParams[];
} {
  const calls: CreateParams[] = [];
  const queue = [...responses];
  const client: MessagesClient = {
    messages: {
      async create(params: CreateParams) {
        calls.push(params);
        const next = queue.shift();
        if (!next) throw new Error("stub: no response queued");
        return next;
      },
    },
  };
  return { client, calls };
}

function message(partial: Partial<Anthropic.Message>): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: DEFAULT_MODEL,
    content: [{ type: "text", text: "olá", citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 120,
      output_tokens: 30,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 10,
    } as Anthropic.Usage,
    ...partial,
  } as Anthropic.Message;
}

const THINKING_BLOCK = {
  type: "thinking",
  thinking: "vou consultar a agenda",
  signature: "sig-opaque",
} as unknown as Anthropic.ContentBlock;

const TOOL_INPUT = { from: "a", to: "b", type: "cleaning" };
const TOOL_USE_BLOCK = {
  type: "tool_use",
  id: "tu_1",
  name: "get_availability",
  input: TOOL_INPUT,
} as unknown as Anthropic.ContentBlock;

const input: LlmTurnInput = {
  system: "sistema",
  tools: toolDefs,
  messages: [{ role: "user", content: [{ type: "text", text: "quero marcar" }] }],
  promptVersion: "v001+abcdef0",
};

describe("AnthropicLLM — request shape for claude-sonnet-5-5 (research R1)", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    vi.stubEnv("ANTHROPIC_MODEL", undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to the production model with thinking between_tools, effort low and strict tools", async () => {
    const { client, calls } = stubClient([message({})]);
    const llm = new AnthropicLLM({ client });

    await llm.turn(input);

    expect(calls).toHaveLength(1);
    const req = calls[0];
    expect(req.model).toBe("claude-sonnet-5-5");
    expect(DEFAULT_MODEL).toBe("claude-sonnet-5-5");
    expect(req.thinking).toEqual({ type: "between_tools" });
    expect(req.output_config).toEqual({ effort: "low" });
    expect(req.tool_choice).toBeUndefined(); // forced tool_choice 400s on this model
    expect(req.tools).toHaveLength(toolDefs.length);
    for (const tool of req.tools as Anthropic.Tool[]) {
      expect(tool.strict).toBe(true);
      expect(tool.input_schema.additionalProperties).toBe(false); // required by strict
    }
    expect(req.system).toBe("sistema");
    expect(req.max_tokens).toBeGreaterThan(0);
  });

  it("never leaks promptVersion (or any non-API field) into the request body", async () => {
    const { client, calls } = stubClient([message({})]);
    await new AnthropicLLM({ client }).turn(input);
    expect(JSON.stringify(calls[0])).not.toContain("promptVersion");
    expect(JSON.stringify(calls[0])).not.toContain("v001+abcdef0");
  });

  it("honours ANTHROPIC_MODEL / an explicit model and tunes the request per model", async () => {
    vi.stubEnv("ANTHROPIC_MODEL", "claude-haiku-4-5");
    const a = stubClient([message({})]);
    await new AnthropicLLM({ client: a.client }).turn(input);
    expect(a.calls[0].model).toBe("claude-haiku-4-5");
    expect(a.calls[0].thinking).toBeUndefined(); // between_tools is Sonnet 5.5-only
    expect(a.calls[0].output_config).toBeUndefined();

    const b = stubClient([message({})]);
    await new AnthropicLLM({ client: b.client, model: "claude-opus-5-5" }).turn(input);
    expect(b.calls[0].model).toBe("claude-opus-5-5");
    expect(b.calls[0].thinking).toBeUndefined(); // thinking cannot be disabled: adaptive by default
    expect(b.calls[0].output_config).toEqual({ effort: "low" });
  });

  it("requestTuningFor is a pure per-model table", () => {
    expect(requestTuningFor("claude-sonnet-5-5")).toEqual({
      thinking: { type: "between_tools" },
      output_config: { effort: "low" },
    });
    expect(requestTuningFor("claude-sonnet-5")).toEqual({ output_config: { effort: "low" } });
    expect(requestTuningFor("claude-opus-5-5")).toEqual({ output_config: { effort: "low" } });
    expect(requestTuningFor("claude-fable-5-1")).toEqual({ output_config: { effort: "low" } });
    expect(requestTuningFor("claude-sonnet-4-6")).toEqual({});
    expect(requestTuningFor("claude-haiku-4-5")).toEqual({});
  });

  it("throws NotConfigured without a key and without an injected client", () => {
    expect(() => new AnthropicLLM()).toThrow(NotConfigured);
    expect(() => new AnthropicLLM({ apiKey: "" })).toThrow(NotConfigured);
  });
});

describe("AnthropicLLM — response mapping onto the port", () => {
  it("maps usage (input/output/cache read/cache write) and tool_use blocks", async () => {
    const { client } = stubClient([
      message({ content: [THINKING_BLOCK, TOOL_USE_BLOCK], stop_reason: "tool_use" }),
    ]);
    const res = await new AnthropicLLM({ client }).turn(input);

    expect(res.stopReason).toBe("tool_use");
    expect(res.usage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
    });
    expect(res.content).toEqual([
      { type: "thinking", raw: THINKING_BLOCK },
      { type: "tool_use", id: "tu_1", name: "get_availability", input: TOOL_INPUT },
    ]);
  });

  it("treats null cache counters as zero", async () => {
    const { client } = stubClient([
      message({
        usage: {
          input_tokens: 5,
          output_tokens: 1,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
        } as Anthropic.Usage,
      }),
    ]);
    const res = await new AnthropicLLM({ client }).turn(input);
    expect(res.usage).toEqual({
      inputTokens: 5,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it.each([
    ["refusal", "refusal"],
    ["max_tokens", "max_tokens"],
    ["model_context_window_exceeded", "max_tokens"],
    ["tool_use", "tool_use"],
    ["end_turn", "end_turn"],
    ["pause_turn", "end_turn"],
    ["stop_sequence", "end_turn"],
    [null, "end_turn"],
  ])("maps stop_reason %j → %s", async (provider, expected) => {
    const { client } = stubClient([
      message({ stop_reason: provider as Anthropic.StopReason, content: [] }),
    ]);
    const res = await new AnthropicLLM({ client }).turn(input);
    expect(res.stopReason).toBe(expected);
  });

  it("round-trips thinking blocks UNCHANGED when the history is replayed within a turn", async () => {
    const { client, calls } = stubClient([message({})]);
    const redacted = {
      type: "redacted_thinking",
      data: "opaque",
    } as unknown as Anthropic.ContentBlock;
    await new AnthropicLLM({ client }).turn({
      ...input,
      messages: [
        { role: "user", content: [{ type: "text", text: "quero marcar" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", raw: THINKING_BLOCK },
            { type: "thinking", raw: redacted },
            { type: "tool_use", id: "tu_1", name: "get_availability", input: { a: 1 } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", toolUseId: "tu_1", content: "{}", isError: false }],
        },
      ],
    });
    const assistant = calls[0].messages[1];
    expect(assistant.role).toBe("assistant");
    const blocks = assistant.content as Anthropic.ContentBlockParam[];
    expect(blocks[0]).toBe(THINKING_BLOCK); // same object: nothing re-shaped or re-signed
    expect(blocks[1]).toBe(redacted);
    expect(blocks[2]).toEqual({
      type: "tool_use",
      id: "tu_1",
      name: "get_availability",
      input: { a: 1 },
    });
    const result = calls[0].messages[2].content as Anthropic.ContentBlockParam[];
    expect(result[0]).toEqual({
      type: "tool_result",
      tool_use_id: "tu_1",
      content: "{}",
      is_error: false,
    });
  });

  it("ignores provider block types the port does not model", async () => {
    const { client } = stubClient([
      message({
        content: [
          {
            type: "server_tool_use",
            id: "x",
            name: "web_search",
            input: {},
          } as unknown as Anthropic.ContentBlock,
          { type: "text", text: "ok", citations: null },
        ],
      }),
    ]);
    const res = await new AnthropicLLM({ client }).turn(input);
    expect(res.content).toEqual([{ type: "text", text: "ok" }]);
  });
});

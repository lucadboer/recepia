import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmProviderError } from "../../src/adapters/llm/errors";
import { OpenAICompatibleLLM } from "../../src/adapters/llm/openai-compatible-llm";
import { toolDefs } from "../../src/agent/tool-schemas";
import { NotConfigured } from "../../src/domain/errors";
import type { LlmTurnInput } from "../../src/ports/llm-port";

// T531 — the fallback adapter speaks the open chat-completions protocol over plain fetch.
// Exercised against a local HTTP stub: no network, no key.

type Handler = (body: Record<string, unknown>, req: IncomingMessage, res: ServerResponse) => void;
let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
  vi.unstubAllEnvs();
});

async function stub(handler: Handler): Promise<{
  baseUrl: string;
  bodies: Record<string, unknown>[];
  headers: IncomingMessage["headers"][];
}> {
  const bodies: Record<string, unknown>[] = [];
  const headers: IncomingMessage["headers"][] = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      bodies.push(body);
      headers.push(req.headers);
      expect(req.url).toBe("/v1/chat/completions");
      handler(body, req, res);
    });
  });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", () => r()));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    bodies,
    headers,
  };
}

const ok = (res: ServerResponse, payload: unknown) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
};

function completion(
  message: Record<string, unknown>,
  finish = "stop",
  usage?: Record<string, unknown>,
) {
  return {
    id: "c1",
    model: "secondary-model-2026",
    choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }],
    usage: usage ?? {
      prompt_tokens: 120,
      completion_tokens: 30,
      prompt_tokens_details: { cached_tokens: 100 },
    },
  };
}

const history: LlmTurnInput = {
  system: "sistema",
  systemCacheablePrefix: 3,
  tools: toolDefs,
  promptVersion: "v001+abc",
  messages: [
    { role: "user", content: [{ type: "text", text: "quero marcar" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", raw: { type: "thinking", thinking: "x", signature: "s" } },
        { type: "text", text: "Vou consultar." },
        {
          type: "tool_use",
          id: "tu_1",
          name: "get_availability",
          input: { from: "a", to: "b", type: "cleaning" },
        },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", toolUseId: "tu_1", content: '{"slots":[]}', isError: false },
      ],
    },
  ],
};

describe("OpenAICompatibleLLM — request mapping", () => {
  it("posts model, system + history (tool_calls / tool role), function tools and the bearer key; drops thinking", async () => {
    const s = await stub((_b, _r, res) => ok(res, completion({ content: "Olá" })));
    const llm = new OpenAICompatibleLLM({
      baseUrl: s.baseUrl,
      apiKey: "sk-test",
      model: "secondary-model",
    });
    await llm.turn(history);
    const body = s.bodies[0];
    expect(s.headers[0].authorization).toBe("Bearer sk-test");
    expect(body.model).toBe("secondary-model");
    expect(body.tool_choice).toBe("auto");
    expect(body.messages).toEqual([
      { role: "system", content: "sistema" },
      { role: "user", content: "quero marcar" },
      {
        role: "assistant",
        content: "Vou consultar.",
        tool_calls: [
          {
            id: "tu_1",
            type: "function",
            function: {
              name: "get_availability",
              arguments: JSON.stringify({ from: "a", to: "b", type: "cleaning" }),
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "tu_1", content: '{"slots":[]}' },
    ]);
    expect(body.tools).toEqual(
      toolDefs.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
    );
    expect(JSON.stringify(body)).not.toContain("promptVersion");
    expect(JSON.stringify(body)).not.toContain("signature");
  });

  it("an assistant turn with only reasoning is omitted; a tool-only assistant turn has null content", async () => {
    const s = await stub((_b, _r, res) => ok(res, completion({ content: "ok" })));
    const llm = new OpenAICompatibleLLM({ baseUrl: s.baseUrl, apiKey: "k", model: "m" });
    await llm.turn({
      ...history,
      messages: [
        { role: "user", content: [{ type: "text", text: "a" }] },
        { role: "assistant", content: [{ type: "thinking", raw: {} }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t", name: "x", input: {} }] },
        {
          role: "user",
          content: [{ type: "tool_result", toolUseId: "t", content: "r", isError: true }],
        },
      ],
    });
    const msgs = s.bodies[0].messages as Record<string, unknown>[];
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(msgs[2].content).toBeNull();
  });
});

describe("OpenAICompatibleLLM — response mapping", () => {
  it("text → end_turn with usage (cached tokens split out), served model and provider", async () => {
    const s = await stub((_b, _r, res) => ok(res, completion({ content: "Olá!" })));
    const r = await new OpenAICompatibleLLM({ baseUrl: s.baseUrl, apiKey: "k", model: "m" }).turn(
      history,
    );
    expect(r).toEqual({
      stopReason: "end_turn",
      content: [{ type: "text", text: "Olá!" }],
      usage: { inputTokens: 20, outputTokens: 30, cacheReadTokens: 100, cacheWriteTokens: 0 },
      model: "secondary-model-2026",
      provider: "openai-compatible",
    });
  });

  it("tool_calls → tool_use blocks with parsed arguments; unparsable arguments become {}", async () => {
    const s = await stub((_b, _r, res) =>
      ok(
        res,
        completion(
          {
            content: null,
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: {
                  name: "hold_slot",
                  arguments: '{"start":"2026-06-16T12:00:00Z","type":"cleaning"}',
                },
              },
              {
                id: "c2",
                type: "function",
                function: { name: "confirm_booking", arguments: "{not json" },
              },
            ],
          },
          "tool_calls",
          { prompt_tokens: 10, completion_tokens: 5 },
        ),
      ),
    );
    const r = await new OpenAICompatibleLLM({ baseUrl: s.baseUrl, apiKey: "k", model: "m" }).turn(
      history,
    );
    expect(r.stopReason).toBe("tool_use");
    expect(r.content).toEqual([
      {
        type: "tool_use",
        id: "c1",
        name: "hold_slot",
        input: { start: "2026-06-16T12:00:00Z", type: "cleaning" },
      },
      { type: "tool_use", id: "c2", name: "confirm_booking", input: {} },
    ]);
    expect(r.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it.each([
    ["length", "max_tokens"],
    ["content_filter", "refusal"],
    ["stop", "end_turn"],
    ["something_new", "end_turn"],
  ])("finish_reason %s → %s", async (finish, expected) => {
    const s = await stub((_b, _r, res) => ok(res, completion({ content: "x" }, finish)));
    const r = await new OpenAICompatibleLLM({ baseUrl: s.baseUrl, apiKey: "k", model: "m" }).turn(
      history,
    );
    expect(r.stopReason).toBe(expected);
  });

  it.each([
    ["content_filter", "refusal"],
    ["length", "max_tokens"],
  ])(
    "review fix M2 — %s WITH tool calls → %s (the orchestrator then runs none of them)",
    async (finish, expected) => {
      const s = await stub((_b, _r, res) =>
        ok(
          res,
          completion(
            {
              content: null,
              tool_calls: [
                {
                  id: "c",
                  type: "function",
                  function: { name: "confirm_booking", arguments: "{}" },
                },
              ],
            },
            finish,
          ),
        ),
      );
      const r = await new OpenAICompatibleLLM({ baseUrl: s.baseUrl, apiKey: "k", model: "m" }).turn(
        history,
      );
      expect(r.stopReason).toBe(expected);
    },
  );

  it("tool calls reported with finish_reason stop are still tool_use", async () => {
    const s = await stub((_b, _r, res) =>
      ok(
        res,
        completion(
          {
            content: null,
            tool_calls: [{ id: "c", type: "function", function: { name: "x", arguments: "{}" } }],
          },
          "stop",
        ),
      ),
    );
    const r = await new OpenAICompatibleLLM({ baseUrl: s.baseUrl, apiKey: "k", model: "m" }).turn(
      history,
    );
    expect(r.stopReason).toBe("tool_use");
  });
});

describe("OpenAICompatibleLLM — errors and configuration", () => {
  it.each([
    [429, true],
    [500, true],
    [503, true],
    [408, true],
    [400, false],
    [401, false],
    [404, false],
  ])("HTTP %i → LlmProviderError transient=%s", async (status, transient) => {
    const s = await stub((_b, _r, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "nope +5531900000101" } }));
    });
    const err = await new OpenAICompatibleLLM({ baseUrl: s.baseUrl, apiKey: "k", model: "m" })
      .turn(history)
      .catch((e) => e);
    expect(err).toBeInstanceOf(LlmProviderError);
    expect(err.status).toBe(status);
    expect(err.transient).toBe(transient);
    expect(err.message).not.toContain("5531900000101");
  });

  it("a timeout and an unreachable host are transient", async () => {
    const s = await stub(() => {
      /* never answers */
    });
    const slow = await new OpenAICompatibleLLM({
      baseUrl: s.baseUrl,
      apiKey: "k",
      model: "m",
      timeoutMs: 100,
    })
      .turn(history)
      .catch((e) => e);
    expect(slow).toBeInstanceOf(LlmProviderError);
    expect(slow.transient).toBe(true);
    expect(slow.message).toMatch(/timeout/i);
    const down = await new OpenAICompatibleLLM({
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "k",
      model: "m",
    })
      .turn(history)
      .catch((e) => e);
    expect(down).toBeInstanceOf(LlmProviderError);
    expect(down.transient).toBe(true);
    expect(down.status).toBeNull();
  });

  it("a 200 without choices is a non-transient provider error", async () => {
    const s = await stub((_b, _r, res) => ok(res, { id: "x", choices: [] }));
    const err = await new OpenAICompatibleLLM({ baseUrl: s.baseUrl, apiKey: "k", model: "m" })
      .turn(history)
      .catch((e) => e);
    expect(err).toBeInstanceOf(LlmProviderError);
    expect(err.transient).toBe(false);
  });

  it("reads FALLBACK_LLM_* from the environment and fails fast without them", () => {
    vi.stubEnv("FALLBACK_LLM_BASE_URL", "https://example.test/v1/");
    vi.stubEnv("FALLBACK_LLM_API_KEY", "k");
    vi.stubEnv("FALLBACK_LLM_MODEL", "m");
    vi.stubEnv("FALLBACK_LLM_TIMEOUT_MS", "1234");
    const llm = new OpenAICompatibleLLM();
    expect(llm.model).toBe("m");
    expect(llm.provider).toBe("openai-compatible");
    expect(llm.timeoutMs).toBe(1234);
    vi.stubEnv("FALLBACK_LLM_API_KEY", "");
    expect(() => new OpenAICompatibleLLM()).toThrow(NotConfigured);
  });
});

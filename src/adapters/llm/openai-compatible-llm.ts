// Secondary model provider (005 FR-513): any endpoint speaking the open chat-completions
// protocol with tool calling, over plain fetch (no provider SDK). Off unless configured:
//   FALLBACK_LLM_BASE_URL (…/v1), FALLBACK_LLM_API_KEY, FALLBACK_LLM_MODEL, FALLBACK_LLM_TIMEOUT_MS.
// Reasoning blocks from the primary are dropped (another provider cannot read them).

import { NotConfigured } from "../../domain/errors.ts";
import type {
  LLMPort,
  LlmContent,
  LlmMessage,
  LlmTurnInput,
  LlmTurnResult,
  LlmUsage,
} from "../../ports/llm-port.ts";
import { maskPhonesIn } from "../../telemetry/pseudonym.ts";
import { isTransientStatus, LlmProviderError } from "./errors.ts";

const MAX_TOKENS = 4096;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface OpenAICompatibleOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatResponse {
  model?: string;
  choices?: {
    message?: { content?: string | null; tool_calls?: ToolCall[] };
    finish_reason?: string;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

export class OpenAICompatibleLLM implements LLMPort {
  readonly provider = "openai-compatible";
  readonly model: string;
  readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(opts: OpenAICompatibleOptions = {}) {
    const baseUrl = opts.baseUrl ?? process.env.FALLBACK_LLM_BASE_URL;
    const apiKey = opts.apiKey ?? process.env.FALLBACK_LLM_API_KEY;
    const model = opts.model ?? process.env.FALLBACK_LLM_MODEL;
    if (!baseUrl || !apiKey || !model) {
      throw new NotConfigured(
        "OpenAICompatibleLLM: FALLBACK_LLM_BASE_URL, FALLBACK_LLM_API_KEY and FALLBACK_LLM_MODEL are required",
      );
    }
    const envTimeout = Number(process.env.FALLBACK_LLM_TIMEOUT_MS);
    this.timeoutMs =
      opts.timeoutMs ??
      (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS);
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.model = model;
  }

  async turn(input: LlmTurnInput): Promise<LlmTurnResult> {
    const body = {
      model: this.model,
      max_tokens: MAX_TOKENS,
      messages: [
        { role: "system", content: input.system } as ChatMessage,
        ...toChatMessages(input.messages),
      ],
      tools: input.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
      tool_choice: "auto",
    };
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const timedOut =
        err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new LlmProviderError(
        timedOut
          ? `timeout after ${this.timeoutMs} ms`
          : `connection failed: ${err instanceof Error ? err.message : String(err)}`,
        null,
        true,
        { cause: err },
      );
    }
    if (!res.ok) {
      const detail = maskPhonesIn((await res.text().catch(() => "")).slice(0, 200));
      throw new LlmProviderError(
        `HTTP ${res.status}: ${detail}`,
        res.status,
        isTransientStatus(res.status),
      );
    }
    const json = (await res.json()) as ChatResponse;
    const choice = json.choices?.[0];
    if (!choice?.message) throw new LlmProviderError("response without choices", res.status, false);
    const content = fromMessage(choice.message);
    return {
      stopReason: mapFinish(choice.finish_reason, content),
      content,
      usage: mapUsage(json.usage),
      model: json.model ?? this.model,
      provider: this.provider,
    };
  }
}

function toChatMessages(messages: LlmMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      for (const c of m.content) {
        if (c.type === "tool_result")
          out.push({ role: "tool", tool_call_id: c.toolUseId, content: c.content });
      }
      const text = m.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      if (text) out.push({ role: "user", content: text });
      continue;
    }
    const text = m.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    const toolCalls: ToolCall[] = m.content
      .filter((c): c is Extract<LlmContent, { type: "tool_use" }> => c.type === "tool_use")
      .map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
      }));
    if (!text && toolCalls.length === 0) continue; // reasoning-only turn: nothing this provider can read
    out.push({
      role: "assistant",
      content: text || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    });
  }
  return out;
}

function fromMessage(message: { content?: string | null; tool_calls?: ToolCall[] }): LlmContent[] {
  const out: LlmContent[] = [];
  if (message.content) out.push({ type: "text", text: message.content });
  for (const tc of message.tool_calls ?? []) {
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(tc.function.arguments);
    } catch {
      parsed = {}; // the registry rejects it as invalid arguments
    }
    out.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: parsed });
  }
  return out;
}

/**
 * A provider refusal or a cut-off wins over tool calls in the same response: the orchestrator
 * then runs none of them (a truncated or filtered tool call is never executed).
 */
function mapFinish(reason: string | undefined, content: LlmContent[]): LlmTurnResult["stopReason"] {
  if (reason === "content_filter") return "refusal";
  if (reason === "length") return "max_tokens";
  return content.some((c) => c.type === "tool_use") ? "tool_use" : "end_turn";
}

function mapUsage(u: ChatResponse["usage"]): LlmUsage {
  const prompt = u?.prompt_tokens ?? 0;
  const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: u?.completion_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

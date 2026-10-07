import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeLLM, finalTurn } from "../../src/adapters/fakes/fake-llm";
import { isTransientLlmError, LlmProviderError } from "../../src/adapters/llm/errors";
import { FallbackExhaustedError, FallbackLLM } from "../../src/adapters/llm/fallback-llm";
import type { LLMPort, LlmTurnInput, LlmTurnResult } from "../../src/ports/llm-port";
import { withSpan } from "../../src/telemetry/tracing";
import { startTestTelemetry, type TestTelemetry } from "../helpers/telemetry";

// T533 — the secondary is used only for transient failures of the primary (FR-513).

const input: LlmTurnInput = { system: "s", tools: [], messages: [] };

class Failing implements LLMPort {
  calls = 0;
  readonly model = "primary-model";
  readonly provider = "anthropic";
  constructor(private readonly err: unknown) {}
  async turn(): Promise<LlmTurnResult> {
    this.calls++;
    throw this.err;
  }
}

class Secondary extends FakeLLM {
  override readonly model = "secondary-model";
  override readonly provider = "openai-compatible";
}

const named = (name: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(name), { name, ...extra });

let tel: TestTelemetry;
beforeAll(() => {
  tel = startTestTelemetry();
});
afterAll(async () => {
  await tel.stop();
});
beforeEach(() => tel.reset());

describe("isTransientLlmError", () => {
  it.each([
    [named("APIConnectionTimeoutError"), true],
    [named("APIConnectionError"), true],
    [named("TimeoutError"), true],
    [named("AbortError"), true],
    [named("RateLimitError", { status: 429 }), true],
    [named("InternalServerError", { status: 500 }), true],
    [named("APIError", { status: 529 }), true],
    [named("APIError", { status: 408 }), true],
    [named("BadRequestError", { status: 400 }), false],
    [named("AuthenticationError", { status: 401 }), false],
    [named("PermissionDeniedError", { status: 403 }), false],
    [new LlmProviderError("x", 503, true), true],
    [new LlmProviderError("x", 400, false), false],
    [new Error("random"), false],
    ["string", false],
  ])("%o → %s", (err, expected) => {
    expect(isTransientLlmError(err)).toBe(expected);
  });
});

describe("FallbackLLM", () => {
  it("serves from the secondary on a transient primary failure, tagging provider/model and the span", async () => {
    const primary = new Failing(named("RateLimitError", { status: 429 }));
    const secondary = new Secondary([finalTurn("oi")]);
    const llm = new FallbackLLM(primary, secondary);
    expect(llm.model).toBe("primary-model");
    expect(llm.provider).toBe("anthropic");
    const r = await withSpan("chat test", {}, () => llm.turn(input));
    expect(r).toMatchObject({
      stopReason: "end_turn",
      provider: "openai-compatible",
      model: "secondary-model",
    });
    expect(primary.calls).toBe(1);
    expect(secondary.callCount).toBe(1);
    const [span] = tel.byName("chat test");
    expect(span.attributes["recepia.llm.fallback"]).toBe(true);
    expect(span.events.map((e) => e.name)).toContain("llm.fallback");
    expect(span.events.find((e) => e.name === "llm.fallback")?.attributes?.["error.type"]).toBe(
      "RateLimitError",
    );
  });

  it.each([
    named("BadRequestError", { status: 400 }),
    named("AuthenticationError", { status: 401 }),
    new Error("bug"),
  ])("never calls the secondary for a non-transient error (%o)", async (err) => {
    const secondary = new Secondary([finalTurn("oi")]);
    await expect(new FallbackLLM(new Failing(err), secondary).turn(input)).rejects.toBe(err);
    expect(secondary.callCount).toBe(0);
  });

  it("a refusal is an answer, not an error: no fallback", async () => {
    const primary = new FakeLLM([{ stopReason: "refusal", content: [] }]);
    const secondary = new Secondary([finalTurn("oi")]);
    const r = await new FallbackLLM(primary, secondary).turn(input);
    expect(r.stopReason).toBe("refusal");
    expect(secondary.callCount).toBe(0);
  });

  it("both failing → FallbackExhaustedError carrying both errors", async () => {
    const pErr = named("APIConnectionTimeoutError");
    const sErr = new LlmProviderError("down", 503, true);
    const secondary: LLMPort = {
      async turn() {
        throw sErr;
      },
    };
    const err = await new FallbackLLM(new Failing(pErr), secondary).turn(input).catch((e) => e);
    expect(err).toBeInstanceOf(FallbackExhaustedError);
    expect(err.primary).toBe(pErr);
    expect(err.secondary).toBe(sErr);
    expect(err.cause).toBe(pErr);
    expect(isTransientLlmError(err)).toBe(true); // classified by the primary
  });
});

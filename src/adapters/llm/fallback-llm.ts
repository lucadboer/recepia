// Primary → secondary on transient failures only (005 FR-513). A refusal is an answer and is
// returned as is; a non-transient error (bad request, auth) is rethrown untouched.

import { trace } from "@opentelemetry/api";
import type { LLMPort, LlmTurnInput, LlmTurnResult } from "../../ports/llm-port.ts";
import { log } from "../../telemetry/logger.ts";
import { ATTR, errorTypeOf } from "../../telemetry/tracing.ts";
import { isTransientLlmError } from "./errors.ts";

export class FallbackExhaustedError extends Error {
  constructor(
    readonly primary: unknown,
    readonly secondary: unknown,
  ) {
    super("primary and fallback model providers both failed", { cause: primary });
    this.name = "FallbackExhaustedError";
  }
}

const errorType = errorTypeOf;

export class FallbackLLM implements LLMPort {
  constructor(
    readonly primary: LLMPort,
    readonly secondary: LLMPort,
    private readonly isTransient: (err: unknown) => boolean = isTransientLlmError,
  ) {}

  get model(): string | undefined {
    return this.primary.model;
  }

  get provider(): string | undefined {
    return this.primary.provider;
  }

  async turn(input: LlmTurnInput): Promise<LlmTurnResult> {
    try {
      return await this.primary.turn(input);
    } catch (err) {
      if (!this.isTransient(err)) throw err;
      const span = trace.getActiveSpan();
      span?.setAttribute(ATTR.llmFallback, true);
      span?.addEvent("llm.fallback", {
        [ATTR.errorType]: errorType(err),
        "recepia.llm.secondary": this.secondary.provider ?? "unknown",
      });
      log.warn(
        {
          event: "llm.fallback",
          errorType: errorType(err),
          secondary: this.secondary.provider,
          model: this.secondary.model,
        },
        "primary model provider failed transiently; using the fallback provider",
      );
      try {
        const r = await this.secondary.turn(input);
        return {
          ...r,
          provider: r.provider ?? this.secondary.provider,
          model: r.model ?? this.secondary.model,
        };
      } catch (secondaryErr) {
        throw new FallbackExhaustedError(err, secondaryErr);
      }
    }
  }
}

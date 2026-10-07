// Tracing over the OpenTelemetry API only (research R1/R2): business code never imports the
// SDK, so with nothing registered every call here is a no-op (FR-506, FR-516). Span and
// attribute names follow the GenAI semantic conventions where they exist, `recepia.*` otherwise.

import {
  type Attributes,
  type AttributeValue,
  context,
  isSpanContextValid,
  type Link,
  propagation,
  ROOT_CONTEXT,
  type Span,
  type SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";

export const TRACER_NAME = "recepia";

export const SPAN = {
  inbound: "webhook.inbound",
  turn: "agent.turn",
  chat: (model: string) => `chat ${model}`,
  tool: (name: string) => `execute_tool ${name}`,
  outboxDispatch: "outbox.dispatch",
  job: (name: string) => `job.${name}`,
} as const;

export const ATTR = {
  // GenAI semantic conventions
  genAiOperation: "gen_ai.operation.name",
  genAiProvider: "gen_ai.provider.name",
  genAiRequestModel: "gen_ai.request.model",
  genAiResponseModel: "gen_ai.response.model",
  genAiInputTokens: "gen_ai.usage.input_tokens",
  genAiOutputTokens: "gen_ai.usage.output_tokens",
  genAiCacheReadTokens: "gen_ai.usage.cache_read.input_tokens",
  genAiCacheWriteTokens: "gen_ai.usage.cache_creation.input_tokens",
  genAiFinishReasons: "gen_ai.response.finish_reasons",
  genAiToolName: "gen_ai.tool.name",
  errorType: "error.type",
  // recepia.*
  channel: "recepia.channel",
  messageId: "recepia.message.id",
  patientId: "recepia.patient.id",
  patientPhoneMasked: "recepia.patient.phone_masked",
  turnStatus: "recepia.turn.status",
  promptVersion: "recepia.prompt.version",
  conversationStatus: "recepia.conversation.status",
  conversationCostUsd: "recepia.conversation.cost_usd",
  llmCostUsd: "recepia.llm.cost_usd",
  llmFallback: "recepia.llm.fallback",
  toolOutcome: "recepia.tool.outcome",
  toolRejectedBy: "recepia.tool.rejected_by",
  toolType: "recepia.tool.appointment_type",
  toolSlotStart: "recepia.tool.slot_start",
  outboxKind: "recepia.outbox.kind",
  outboxAttempt: "recepia.outbox.attempt",
  outboxResult: "recepia.outbox.result",
} as const;

export function tracer() {
  return trace.getTracer(TRACER_NAME);
}

export type MaybeAttributes = Record<string, AttributeValue | undefined>;

function defined(attrs: MaybeAttributes): Attributes {
  const out: Attributes = {};
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) out[k] = v;
  return out;
}

export function setAttributes(span: Span, attrs: MaybeAttributes): void {
  span.setAttributes(defined(attrs));
}

export interface SpanOptions {
  kind?: SpanKind;
  links?: Link[];
  /** Start a new trace instead of a child of the active span. */
  root?: boolean;
}

/** Run `fn` in an active span; exceptions are recorded (error.type, ERROR) and rethrown. */
export async function withSpan<T>(
  name: string,
  attributes: MaybeAttributes,
  fn: (span: Span) => Promise<T> | T,
  opts: SpanOptions = {},
): Promise<T> {
  const parent = opts.root ? ROOT_CONTEXT : context.active();
  return tracer().startActiveSpan(
    name,
    { kind: opts.kind, links: opts.links, attributes: defined(attributes), root: opts.root },
    parent,
    async (span) => {
      try {
        return await fn(span);
      } catch (err) {
        recordError(span, err);
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Start a root span now (e.g. when a webhook accepts a message) and run work in it later
 * (after a queue wait); the span ends when the work settles.
 */
export function startRootSpan(
  name: string,
  attributes: MaybeAttributes,
  kind?: SpanKind,
): { span: Span; run<T>(fn: () => Promise<T>): Promise<T> } {
  const span = tracer().startSpan(
    name,
    { kind, root: true, attributes: defined(attributes) },
    ROOT_CONTEXT,
  );
  return {
    span,
    async run<T>(fn: () => Promise<T>): Promise<T> {
      try {
        return await context.with(trace.setSpan(ROOT_CONTEXT, span), fn);
      } catch (err) {
        recordError(span, err);
        throw err;
      } finally {
        span.end();
      }
    },
  };
}

/** The most specific error class name: the subclass (SDK errors) or a custom `name`. */
export function errorTypeOf(err: unknown): string {
  if (!(err instanceof Error)) return typeof err;
  const ctor = err.constructor?.name;
  return ctor && ctor !== "Error" ? ctor : err.name || "Error";
}

export function recordError(span: Span, err: unknown): void {
  const type = errorTypeOf(err);
  span.setAttribute(ATTR.errorType, type);
  if (err instanceof Error) span.recordException({ name: type, message: err.message });
  span.setStatus({ code: SpanStatusCode.ERROR, message: type });
}

/** W3C traceparent of the active span, or null when tracing is off / nothing is active. */
export function currentTraceparent(): string | null {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent ?? null;
}

/** A span link to a stored traceparent (undefined when absent, malformed or tracing is off). */
export function linkFromTraceparent(traceparent: string | null | undefined): Link | undefined {
  if (!traceparent) return undefined;
  const ctx = propagation.extract(ROOT_CONTEXT, { traceparent });
  const sc = trace.getSpanContext(ctx);
  return sc && isSpanContextValid(sc) ? { context: sc } : undefined;
}

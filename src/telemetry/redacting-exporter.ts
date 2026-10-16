// Last line of defence before spans leave the process (005 FR-505): third-party
// instrumentations (pg, http) can put raw error messages in the span status and in exception
// events. Every exported string is passed through the phone-masking backstop, and exception
// messages/stack traces are dropped (our own code never records them; see recordError).

import type { ReadableSpan, SpanExporter, TimedEvent } from "@opentelemetry/sdk-trace-node";
import { maskPhonesIn } from "./pseudonym.ts";

const DROPPED_EVENT_KEYS = new Set(["exception.message", "exception.stacktrace"]);
const MAX_STATUS = 200;

type Attrs = ReadableSpan["attributes"];

function maskAttrs(attrs: Attrs | undefined, drop?: Set<string>): Attrs {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (drop?.has(k)) continue;
    if (typeof v === "string") out[k] = maskPhonesIn(v);
    else if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === "string" ? maskPhonesIn(x) : x));
    else out[k] = v;
  }
  return out as Attrs;
}

export function redactSpan(span: ReadableSpan): ReadableSpan {
  const status = {
    ...span.status,
    ...(span.status.message
      ? { message: maskPhonesIn(span.status.message).slice(0, MAX_STATUS) }
      : {}),
  };
  const attributes = maskAttrs(span.attributes);
  const events: TimedEvent[] = span.events.map((e) => ({
    ...e,
    attributes: maskAttrs(e.attributes, DROPPED_EVENT_KEYS),
  }));
  return new Proxy(span, {
    get(target, prop) {
      if (prop === "status") return status;
      if (prop === "attributes") return attributes;
      if (prop === "events") return events;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export class RedactingSpanExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}

  export(spans: ReadableSpan[], resultCallback: Parameters<SpanExporter["export"]>[1]): void {
    this.inner.export(spans.map(redactSpan), resultCallback);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

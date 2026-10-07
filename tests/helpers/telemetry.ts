import { context, propagation, trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";

/**
 * Registers a global tracer provider that keeps finished spans in memory (W3C propagator and
 * the async-hooks context manager come with `register()`). One per test file: vitest isolates
 * files, and `stop()` unregisters the globals so later suites see the no-op API again.
 */
export interface TestTelemetry {
  exporter: InMemorySpanExporter;
  spans(): ReadableSpan[];
  byName(name: string): ReadableSpan[];
  reset(): void;
  stop(): Promise<void>;
}

export function startTestTelemetry(): TestTelemetry {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  provider.register();
  return {
    exporter,
    spans: () => exporter.getFinishedSpans(),
    byName: (name) => exporter.getFinishedSpans().filter((s) => s.name === name),
    reset: () => exporter.reset(),
    stop: async () => {
      await provider.shutdown();
      trace.disable();
      context.disable();
      propagation.disable();
    },
  };
}

/** Every string an exporter would ship: names, attribute values, event names/attributes, status. */
export function telemetryStrings(spans: ReadableSpan[]): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) for (const x of v) push(x);
    else if (v !== null && v !== undefined) out.push(String(v));
  };
  for (const s of spans) {
    push(s.name);
    for (const v of Object.values(s.attributes)) push(v);
    for (const e of s.events) {
      push(e.name);
      for (const v of Object.values(e.attributes ?? {})) push(v);
    }
    push(s.status.message);
  }
  return out;
}

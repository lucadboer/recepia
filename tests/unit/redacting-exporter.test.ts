import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { afterAll, describe, expect, it } from "vitest";
import { RedactingSpanExporter } from "../../src/telemetry/redacting-exporter";

// Review fix L3 — third-party instrumentations (pg, http) can put raw error text in span status
// and exception events; the exporter masks phones and drops exception messages before export.

describe("RedactingSpanExporter", () => {
  const sink = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(new RedactingSpanExporter(sink))],
  });
  const tracer = provider.getTracer("t");
  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
  });

  it("masks phones in status and attributes, drops exception message/stack, keeps everything else", () => {
    const span = tracer.startSpan("pg.query:INSERT recepia");
    span.setAttribute("db.statement", "INSERT INTO booking (patient_phone) VALUES ($1)");
    span.setAttribute("note", "for +5531900000101");
    span.recordException({
      name: "error",
      message: 'invalid input: "+5531900000101"',
      stack: "at +5531900000101",
    });
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: `duplicate key for 5531900000101 ${"x".repeat(500)}`,
    });
    span.end();
    const [out] = sink.getFinishedSpans();
    expect(out.name).toBe("pg.query:INSERT recepia");
    expect(out.attributes["db.statement"]).toBe("INSERT INTO booking (patient_phone) VALUES ($1)");
    expect(out.attributes.note).toBe("for ***0101");
    expect(out.status.code).toBe(SpanStatusCode.ERROR);
    expect(out.status.message).toContain("***0101");
    expect(out.status.message?.length).toBeLessThanOrEqual(200);
    const exc = out.events.find((e) => e.name === "exception");
    expect(exc?.attributes?.["exception.message"]).toBeUndefined();
    expect(exc?.attributes?.["exception.stacktrace"]).toBeUndefined();
    expect(exc?.attributes?.["exception.type"]).toBe("error");
    expect(out.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/); // methods still work through the proxy
    expect(JSON.stringify(out.attributes)).not.toContain("5531900000101");
  });
});

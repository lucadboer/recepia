import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  currentTraceparent,
  linkFromTraceparent,
  setAttributes,
  withSpan,
} from "../../src/telemetry/tracing";
import { startTestTelemetry, type TestTelemetry } from "../helpers/telemetry";

// T507 — tracing helpers over the OTel API (no-op unless a provider is registered).

describe("tracing helpers — no provider registered", () => {
  it("withSpan just runs the function and traceparent is null", async () => {
    expect(await withSpan("noop", { a: 1 }, async () => 42)).toBe(42);
    expect(currentTraceparent()).toBeNull();
    expect(
      linkFromTraceparent("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"),
    ).toBeUndefined();
  });
});

describe("tracing helpers — in-memory provider", () => {
  let tel: TestTelemetry;
  beforeAll(() => {
    tel = startTestTelemetry();
  });
  afterAll(async () => {
    await tel.stop();
  });
  beforeEach(() => tel.reset());

  it("records attributes (skipping undefined), nests by active context and returns the value", async () => {
    const v = await withSpan("parent", { "x.a": 1, "x.skip": undefined }, async () =>
      withSpan("child", { "x.b": "b" }, async (span) => {
        setAttributes(span, { "x.c": true, "x.none": undefined });
        return "ok";
      }),
    );
    expect(v).toBe("ok");
    const [parent] = tel.byName("parent");
    const [child] = tel.byName("child");
    expect(parent.attributes).toEqual({ "x.a": 1 });
    expect(child.attributes).toEqual({ "x.b": "b", "x.c": true });
    expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(child.spanContext().traceId).toBe(parent.spanContext().traceId);
  });

  it("records an exception with error.type and ERROR status, then rethrows", async () => {
    class SlotUnavailableError extends Error {}
    await expect(
      withSpan("fails", {}, async () => {
        throw new SlotUnavailableError("taken");
      }),
    ).rejects.toThrow("taken");
    const [s] = tel.byName("fails");
    expect(s.status.code).toBe(SpanStatusCode.ERROR);
    expect(s.attributes["error.type"]).toBe("SlotUnavailableError");
    expect(s.events.some((e) => e.name === "exception")).toBe(true);
    // review fix H3: no free-form message on spans (it can carry provider bodies / phones)
    const exc = s.events.find((e) => e.name === "exception");
    expect(exc?.attributes?.["exception.message"]).toBeUndefined();
    expect(s.status.message).toBe("SlotUnavailableError");
  });

  it("supports kind, root spans and links", async () => {
    let tp: string | null = null;
    await withSpan("origin", {}, async () => {
      tp = currentTraceparent();
    });
    expect(tp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    await withSpan("outer", {}, async () =>
      withSpan("detached", {}, async () => undefined, {
        kind: SpanKind.CONSUMER,
        root: true,
        links: [linkFromTraceparent(tp)].filter((l) => l !== undefined),
      }),
    );
    const [origin] = tel.byName("origin");
    const [outer] = tel.byName("outer");
    const [detached] = tel.byName("detached");
    expect(detached.kind).toBe(SpanKind.CONSUMER);
    expect(detached.parentSpanContext).toBeUndefined();
    expect(detached.spanContext().traceId).not.toBe(outer.spanContext().traceId);
    expect(detached.links[0].context.spanId).toBe(origin.spanContext().spanId);
  });

  it("linkFromTraceparent rejects malformed input", () => {
    expect(linkFromTraceparent(null)).toBeUndefined();
    expect(linkFromTraceparent("garbage")).toBeUndefined();
    expect(
      linkFromTraceparent("00-00000000000000000000000000000000-0000000000000000-01"),
    ).toBeUndefined();
  });

  it("a span left active by the API is visible through trace.getActiveSpan()", async () => {
    await withSpan("active", {}, async (span) => {
      expect(trace.getActiveSpan()?.spanContext().spanId).toBe(span.spanContext().spanId);
    });
  });
});

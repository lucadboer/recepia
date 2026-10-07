import { Writable } from "node:stream";
import { trace } from "@opentelemetry/api";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configureLogger, log } from "../../src/telemetry/logger";
import { startTestTelemetry, type TestTelemetry } from "../helpers/telemetry";

// T505 — structured JSON logs, trace correlation, PII backstop (FR-505, FR-507).

const PHONE = "+5531900000101";
let lines: Record<string, unknown>[] = [];
let raw: string[] = [];
let tel: TestTelemetry;

function capture(level = "debug"): void {
  lines = [];
  raw = [];
  const destination = new Writable({
    write(chunk, _enc, cb) {
      const s = chunk.toString();
      raw.push(s);
      for (const l of s.split("\n").filter(Boolean)) lines.push(JSON.parse(l));
      cb();
    },
  });
  configureLogger({ level, destination });
}

beforeAll(() => {
  tel = startTestTelemetry();
});
afterAll(async () => {
  await tel.stop();
  configureLogger({ level: "silent" });
});
beforeEach(() => capture());

describe("logger", () => {
  it("writes one JSON line with level, time, msg, service and the given fields", () => {
    log.info({ event: "turn.done", messageId: "m1" }, "turn finished");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "info",
      msg: "turn finished",
      service: "recepia",
      event: "turn.done",
      messageId: "m1",
    });
    expect(typeof lines[0].time).toBe("string");
    expect(lines[0].trace_id).toBeUndefined(); // no active span
  });

  it("adds trace_id/span_id inside an active span", () => {
    const tracer = trace.getTracer("t");
    tracer.startActiveSpan("s", (span) => {
      log.info({ event: "x" }, "inside");
      const ctx = span.spanContext();
      expect(lines[0]).toMatchObject({ trace_id: ctx.traceId, span_id: ctx.spanId });
      span.end();
    });
  });

  it("masks phone numbers anywhere: message, nested fields, arrays and errors", () => {
    log.warn(
      { event: "conflict", nested: { note: `saw ${PHONE}`, list: [PHONE] } },
      `conflict for ${PHONE}`,
    );
    log.error({ err: new Error(`save failed for ${PHONE}`) }, "boom");
    const all = raw.join("");
    expect(all).not.toContain(PHONE);
    expect(all).not.toContain("5531900000101");
    expect(all).toContain("***0101");
  });

  it("drops message-content keys (text, body, content, patient_name) at any depth", () => {
    log.info(
      {
        text: "estou com dor",
        body: "Sua consulta...",
        deep: { content: "x", patient_name: "Ana Teste", keep: 1 },
      },
      "m",
    );
    expect(lines[0].text).toBeUndefined();
    expect(lines[0].body).toBeUndefined();
    expect(lines[0].deep).toEqual({ keep: 1 });
    expect(raw.join("")).not.toContain("Ana Teste");
  });

  it("child loggers carry their bindings; the level is configurable", () => {
    log.child({ component: "webhook" }).info({ event: "e" }, "child");
    expect(lines[0]).toMatchObject({ component: "webhook", event: "e" });
    capture("warn");
    log.info({ event: "hidden" }, "hidden");
    log.warn({ event: "shown" }, "shown");
    expect(lines.map((l) => l.event)).toEqual(["shown"]);
  });
});

// Structured logs (FR-507): JSON lines via pino with the active trace/span ids, and two PII
// guards (FR-505): message-content keys are dropped at any depth and every string is passed
// through the phone-masking backstop. Business code imports `log`; tests swap the destination
// with configureLogger().

import { isSpanContextValid, trace } from "@opentelemetry/api";
import pino, { type DestinationStream, type Logger } from "pino";
import { maskPhonesIn } from "./pseudonym";
import { errorTypeOf } from "./tracing";

const DROPPED_KEYS = new Set(["text", "body", "content", "patient_name", "patientName"]);
const MAX_DEPTH = 8;

function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return maskPhonesIn(value);
  // formatters.log runs BEFORE serializers: an Error must be serialized here or its non-enumerable
  // message/stack vanish ("[object Object]").
  if (value instanceof Error) return serializeError(value);
  if (depth >= MAX_DEPTH || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (DROPPED_KEYS.has(k)) continue;
    out[k] = scrub(v, depth + 1);
  }
  return out;
}

function serializeError(err: unknown): Record<string, unknown> {
  // Idempotent: pino runs formatters.log (which already serialized the Error) before serializers.
  if (err && typeof err === "object" && !(err instanceof Error) && "message" in err) {
    return err as Record<string, unknown>;
  }
  if (!(err instanceof Error)) return { message: maskPhonesIn(String(err)) };
  return {
    type: errorTypeOf(err), // the subclass name (SDK errors leave `name` as "Error")
    message: maskPhonesIn(err.message),
    stack: err.stack ? maskPhonesIn(err.stack) : undefined,
  };
}

export interface LoggerOptions {
  level?: string;
  destination?: DestinationStream;
}

function create({
  level = process.env.LOG_LEVEL || "info",
  destination,
}: LoggerOptions = {}): Logger {
  return pino(
    {
      level,
      base: { service: "recepia" },
      messageKey: "msg",
      timestamp: pino.stdTimeFunctions.isoTime,
      serializers: { err: serializeError, error: serializeError },
      formatters: {
        level: (label) => ({ level: label }),
        log: (obj) => scrub(obj) as Record<string, unknown>,
      },
      mixin() {
        const ctx = trace.getActiveSpan()?.spanContext();
        return ctx && isSpanContextValid(ctx) ? { trace_id: ctx.traceId, span_id: ctx.spanId } : {};
      },
      hooks: {
        // The message string bypasses formatters.log: mask it here.
        logMethod(args, method) {
          const masked = args.map((a) => (typeof a === "string" ? maskPhonesIn(a) : a));
          return method.apply(this, masked as Parameters<typeof method>);
        },
      },
    },
    destination ?? pino.destination({ dest: 1, sync: false }),
  );
}

// Created on first use, so LOG_LEVEL loaded from .env after imports (CLIs) is honoured.
let instance: Logger | null = null;
const current = (): Logger => {
  instance ??= create();
  return instance;
};

/** Replace the process logger (level and/or destination) — used by tests and the CLI. */
export function configureLogger(opts: LoggerOptions): void {
  instance = create(opts);
}

type Fields = Record<string, unknown>;

/** Facade bound to the current logger at call time (so configureLogger affects every module). */
export const log = {
  debug: (fields: Fields, msg?: string) => current().debug(fields, msg),
  info: (fields: Fields, msg?: string) => current().info(fields, msg),
  warn: (fields: Fields, msg?: string) => current().warn(fields, msg),
  error: (fields: Fields, msg?: string) => current().error(fields, msg),
  child: (bindings: Fields): Logger => current().child(bindings),
};

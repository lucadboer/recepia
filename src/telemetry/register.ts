// Telemetry bootstrap (research R1). Loaded with `node --import tsx --import ./src/telemetry/register.ts`
// so the pg instrumentation is in place before `pg` is imported. Tracing is ON only when an
// OTLP endpoint is configured; otherwise nothing is registered and the API stays a no-op.

import { readFileSync } from "node:fs";
import { register as registerLoaderHook } from "node:module";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { RedactingSpanExporter } from "./redacting-exporter.ts";

let provider: NodeTracerProvider | null = null;

/** .env must be in process.env before the provider and the logger read their settings. */
function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    // no .env: rely on the ambient environment
  }
}

export function telemetryEndpointConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
}

function serviceVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    return String(pkg.version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

export function startTelemetry(env: NodeJS.ProcessEnv = process.env): boolean {
  if (provider || !telemetryEndpointConfigured(env)) return provider !== null;
  // ESM imports go through import-in-the-middle; CJS requires through require-in-the-middle.
  registerLoaderHook("@opentelemetry/instrumentation/hook.mjs", import.meta.url);
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "service.name": env.OTEL_SERVICE_NAME || "recepia",
      "service.version": serviceVersion(),
    }),
    // The exporter reads OTEL_EXPORTER_OTLP_* itself (endpoint, headers, timeout).
    spanProcessors: [new BatchSpanProcessor(new RedactingSpanExporter(new OTLPTraceExporter()))],
  });
  provider.register();
  // Statement text only — never parameter values (they can carry phones and names); and only
  // inside a traced operation (polling jobs and /readyz would otherwise emit a trace per query).
  registerInstrumentations({
    instrumentations: [
      new PgInstrumentation({ enhancedDatabaseReporting: false, requireParentSpan: true }),
    ],
  });
  return true;
}

/** Flush pending spans on shutdown (wired into the graceful shutdown). */
export async function shutdownTelemetry(): Promise<void> {
  if (!provider) return;
  const p = provider;
  provider = null;
  await p.shutdown().catch(() => {});
}

loadDotEnv();
startTelemetry();

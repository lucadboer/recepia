import { handleInbound } from "./agent/orchestrator";
import type { InboundMessage } from "./agent/types";
import { buildAgentDeps, closeAgentDeps } from "./composition";
import { startJobs } from "./jobs/scheduler";
import { log } from "./telemetry/logger";
import { usingRandomPseudonymKey } from "./telemetry/pseudonym";
import { shutdownTelemetry, telemetryEndpointConfigured } from "./telemetry/register";
import { PerKeyQueue } from "./webhook/per-key-queue";
import { type CloudWebhookOptions, createWebhookServer } from "./webhook/server";
import { createShutdown } from "./webhook/shutdown";

/**
 * Production entrypoint: wire the real AgentDeps into the webhook server. The HTTP
 * layer holds no business logic — it only verifies origin, dedupes, and hands fresh
 * inbound messages to handleInbound. Run with `pnpm start` (needs all credentials).
 */
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} not set (NEEDS-USER)`);
  return value;
}

const deps = buildAgentDeps();
const secret = requiredEnv("WEBHOOK_SECRET");
const port = Number(process.env.PORT ?? 3000);

// Mount the Cloud API webhook only when both the verify token and app secret are present.
const cloud: CloudWebhookOptions | undefined =
  process.env.WHATSAPP_VERIFY_TOKEN && process.env.WHATSAPP_APP_SECRET
    ? {
        verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
        appSecret: process.env.WHATSAPP_APP_SECRET,
        onInbound: (msg: InboundMessage) => handleInbound(deps, msg),
      }
    : undefined;

const queue = new PerKeyQueue();
const server = createWebhookServer({
  secret,
  onInbound: (msg) => handleInbound(deps, msg),
  cloud,
  queue,
  // Readiness = the database answers (liveness needs nothing).
  ready: async () => {
    await deps.pool.query("SELECT 1");
    return true;
  },
});
// Background jobs: outbox delivery (retries) + hold-expiry sweep (T245).
const jobs = startJobs(deps);
// Graceful shutdown (T246): stop jobs, stop accepting, drain in-flight turns, close the pool.
const shutdown = createShutdown({ server, jobs, queue, close: () => closeAgentDeps(deps) });

/**
 * Flush telemetry AFTER the drain settles, whatever its outcome, on its own short budget: the
 * spans of turns that got stuck are exactly the ones worth keeping, and a timed-out drain must
 * not skip the flush.
 */
const TELEMETRY_FLUSH_MS = 3_000;
async function flushTelemetryAndExit(code: number): Promise<never> {
  await Promise.race([
    shutdownTelemetry(),
    new Promise<void>((resolve) => setTimeout(resolve, TELEMETRY_FLUSH_MS).unref()),
  ]);
  process.exit(code);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    log.info({ event: "signal", signal }, "shutdown requested");
    shutdown().then(
      (clean) => flushTelemetryAndExit(clean ? 0 : 1),
      (err) => {
        log.error({ event: "shutdown.failed", err }, "shutdown failed");
        return flushTelemetryAndExit(1);
      },
    );
  });
}
if (usingRandomPseudonymKey()) {
  log.warn(
    { event: "telemetry.random_pseudonym_key" },
    "TELEMETRY_HASH_KEY not set: patient pseudonyms change on every restart",
  );
}
server.listen(port, () => {
  log.info(
    {
      event: "server.listening",
      port,
      jobs: jobs.map((j) => j.name),
      cloudWebhook: Boolean(cloud),
      tracing: telemetryEndpointConfigured(),
    },
    "webhook listening (evolution: POST /webhook/evolution/<token>; cloud: /webhook/cloud when configured)",
  );
});

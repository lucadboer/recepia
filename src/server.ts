import { handleInbound } from "./agent/orchestrator";
import { buildAgentDeps, closeAgentDeps, reminderSettings } from "./composition";
import { createInboundWorker } from "./jobs/inbound-worker";
import { startJobs } from "./jobs/scheduler";
import { log } from "./telemetry/logger";
import { usingRandomPseudonymKey } from "./telemetry/pseudonym";
import { shutdownTelemetry, telemetryEndpointConfigured } from "./telemetry/register";
import { createDurableEnqueue } from "./webhook/enqueue";
import { type CloudWebhookOptions, createWebhookServer } from "./webhook/server";
import { createShutdown } from "./webhook/shutdown";

/**
 * Production entrypoint: wire the real AgentDeps into the webhook server. The HTTP
 * layer holds no business logic — it verifies origin and stores each message durably; the
 * inbound worker hands them to handleInbound. Run with `pnpm start` (needs all credentials).
 */
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} not set (NEEDS-USER)`);
  return value;
}

const deps = buildAgentDeps();
const secret = requiredEnv("WEBHOOK_SECRET");
const port = Number(process.env.PORT ?? 3000);

// 008: every verified message is stored before the webhook answers; the worker runs the turns
// (FIFO per phone, one in flight per phone, lease-based crash recovery).
const worker = createInboundWorker({
  pool: deps.pool,
  clock: deps.clock,
  receptionPhone: deps.receptionPhone,
  handler: (msg) => handleInbound(deps, msg),
});
const enqueue = createDurableEnqueue({
  pool: deps.pool,
  clock: deps.clock,
  onStored: () => worker.wake(),
});

// Mount the Cloud API webhook only when both the verify token and app secret are present.
const cloud: CloudWebhookOptions | undefined =
  process.env.WHATSAPP_VERIFY_TOKEN && process.env.WHATSAPP_APP_SECRET
    ? {
        verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
        appSecret: process.env.WHATSAPP_APP_SECRET,
      }
    : undefined;

const server = createWebhookServer({
  secret,
  enqueue,
  cloud,
  // Readiness = the database answers (liveness needs nothing).
  ready: async () => {
    await deps.pool.query("SELECT 1");
    return true;
  },
});
// Background jobs: outbox delivery (retries) + hold-expiry sweep (T245).
// Reminders (007): settings are validated at startup (official channel needs a template).
const reminders = reminderSettings();
const jobs = startJobs(deps, undefined, reminders.enabled ? reminders : null);
// Graceful shutdown (T246): stop jobs, stop accepting, drain in-flight turns, close the pool.
worker.start();
const shutdown = createShutdown({
  server,
  jobs,
  queue: worker,
  close: () => closeAgentDeps(deps),
});

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

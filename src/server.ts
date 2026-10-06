import { handleInbound } from "./agent/orchestrator";
import type { InboundMessage } from "./agent/types";
import { buildAgentDeps, closeAgentDeps } from "./composition";
import { startJobs } from "./jobs/scheduler";
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
});
// Background jobs: outbox delivery (retries) + hold-expiry sweep (T245).
const jobs = startJobs(deps);
// Graceful shutdown (T246): stop jobs, stop accepting, drain in-flight turns, close the pool.
const shutdown = createShutdown({ server, jobs, queue, close: () => closeAgentDeps(deps) });
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    console.log(`[recepia] ${signal} received`);
    shutdown().then(
      (clean) => process.exit(clean ? 0 : 1),
      (err) => {
        console.error("[recepia] shutdown failed", err);
        process.exit(1);
      },
    );
  });
}
server.listen(port, () => {
  console.log(`[recepia] webhook listening on :${port}`);
  console.log(`  jobs:      ${jobs.map((j) => j.name).join(", ")}`);
  console.log("  evolution: POST /webhook/evolution/<token>");
  console.log(
    cloud
      ? "  cloud:     GET+POST /webhook/cloud (verify challenge + X-Hub-Signature-256)"
      : "  cloud:     (disabled — set WHATSAPP_VERIFY_TOKEN + WHATSAPP_APP_SECRET to enable)",
  );
});

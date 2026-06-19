import { handleInbound } from "./agent/orchestrator";
import { buildAgentDeps } from "./composition";
import { createWebhookServer } from "./webhook/server";

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

const server = createWebhookServer({ secret, onInbound: (msg) => handleInbound(deps, msg) });
server.listen(port, () => {
  console.log(`[recepia] webhook listening on :${port} (POST /webhook/evolution/<token>)`);
});

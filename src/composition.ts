import { GoogleCalendar } from "./adapters/calendar/google-calendar";
import { AnthropicLLM } from "./adapters/llm/anthropic-llm";
import { CloudApiMessaging } from "./adapters/messaging/cloud-api-messaging";
import { EvolutionMessaging } from "./adapters/messaging/evolution-messaging";
import type { AgentDeps } from "./agent/orchestrator";
import { loadEnv } from "./db/env";
import { makePool } from "./db/pool";
import { DbConversationStore } from "./db/repositories/conversation-repo";
import { NotConfigured } from "./domain/errors";
import { systemClock } from "./ports/clock";
import type { MessagingPort } from "./ports/messaging-port";

/** Pick the outbound WhatsApp provider. MESSAGING_PROVIDER=cloud -> Cloud API; default -> Evolution. */
export function buildMessaging(): MessagingPort {
  const provider = (process.env.MESSAGING_PROVIDER ?? "evolution").toLowerCase();
  if (provider === "cloud" || provider === "cloud-api" || provider === "whatsapp-cloud") {
    return new CloudApiMessaging();
  }
  return new EvolutionMessaging();
}

/**
 * Production composition root: build the real AgentDeps from env-configured adapters.
 * Each adapter fails fast with NotConfigured when its credentials are absent, so this
 * cannot be called in the default offline suite — only in the live e2e / production
 * entrypoint. The deterministic tools remain the only writers; this just wires the
 * real LLM/Calendar/WhatsApp/DB behind the same ports the fakes implement.
 */
export function buildAgentDeps(): AgentDeps {
  loadEnv();
  const receptionPhone = process.env.RECEPTION_PHONE;
  if (!receptionPhone) {
    throw new NotConfigured("RECEPTION_PHONE not set (NEEDS-USER)");
  }
  const pool = makePool();
  return {
    pool,
    clock: systemClock,
    calendar: new GoogleCalendar(),
    messaging: buildMessaging(),
    receptionPhone,
    llm: new AnthropicLLM(),
    conversations: new DbConversationStore(pool),
  };
}

export async function closeAgentDeps(deps: AgentDeps): Promise<void> {
  await deps.pool.end();
}

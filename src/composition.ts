import { GoogleCalendar } from "./adapters/calendar/google-calendar";
import { AnthropicLLM } from "./adapters/llm/anthropic-llm";
import { EvolutionMessaging } from "./adapters/messaging/evolution-messaging";
import type { AgentDeps } from "./agent/orchestrator";
import { loadEnv } from "./db/env";
import { makePool } from "./db/pool";
import { DbConversationStore } from "./db/repositories/conversation-repo";
import { NotConfigured } from "./domain/errors";
import { systemClock } from "./ports/clock";

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
    messaging: new EvolutionMessaging(),
    receptionPhone,
    llm: new AnthropicLLM(),
    conversations: new DbConversationStore(pool),
  };
}

export async function closeAgentDeps(deps: AgentDeps): Promise<void> {
  await deps.pool.end();
}

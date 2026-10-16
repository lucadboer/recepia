import { GoogleCalendar } from "./adapters/calendar/google-calendar.ts";
import { AnthropicLLM, DEFAULT_MODEL } from "./adapters/llm/anthropic-llm.ts";
import { FallbackLLM } from "./adapters/llm/fallback-llm.ts";
import { OpenAICompatibleLLM } from "./adapters/llm/openai-compatible-llm.ts";
import { CloudApiMessaging } from "./adapters/messaging/cloud-api-messaging.ts";
import { EvolutionMessaging } from "./adapters/messaging/evolution-messaging.ts";
import type { AgentDeps } from "./agent/orchestrator.ts";
import { DEFAULT_AGENT_BUDGET_USD } from "./config.ts";
import { loadEnv } from "./db/env.ts";
import { makePool } from "./db/pool.ts";
import { DbConversationStore } from "./db/repositories/conversation-repo.ts";
import { NotConfigured } from "./domain/errors.ts";
import type { ReminderSettings } from "./jobs/reminders.ts";
import { assertPriced, loadPricing } from "./llm/pricing.ts";
import { systemClock } from "./ports/clock.ts";
import type { MessagingPort } from "./ports/messaging-port.ts";

function isCloudProvider(raw: string | undefined): boolean {
  const provider = (raw ?? "evolution").toLowerCase();
  return provider === "cloud" || provider === "cloud-api" || provider === "whatsapp-cloud";
}

/** Pick the outbound WhatsApp provider. MESSAGING_PROVIDER=cloud -> Cloud API; default -> Evolution. */
export function buildMessaging(): MessagingPort {
  return isCloudProvider(process.env.MESSAGING_PROVIDER)
    ? new CloudApiMessaging()
    : new EvolutionMessaging();
}

export interface ReminderConfig extends ReminderSettings {
  enabled: boolean;
}

const HOUR_MS = 3_600_000;

function positiveHours(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback * HOUR_MS;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) {
    throw new NotConfigured(`${name} must be a positive number of hours, got "${raw}"`);
  }
  return n * HOUR_MS;
}

/**
 * Reminder settings (007 FR-706/707): REMINDERS_ENABLED (default on), REMINDER_LEAD_HOURS (24),
 * UNCONFIRMED_NOTICE_LEAD_HOURS (3), WHATSAPP_REMINDER_TEMPLATE / _LANG (pt_BR). The official
 * channel cannot start a conversation without an approved template: Cloud + reminders on + no
 * template fails fast at startup instead of silently dropping every reminder.
 */
export function reminderSettings(env: NodeJS.ProcessEnv = process.env): ReminderConfig {
  const enabled = (env.REMINDERS_ENABLED ?? "true").trim().toLowerCase() !== "false";
  const leadMs = positiveHours(env.REMINDER_LEAD_HOURS, "REMINDER_LEAD_HOURS", 24);
  const noticeLeadMs = positiveHours(
    env.UNCONFIRMED_NOTICE_LEAD_HOURS,
    "UNCONFIRMED_NOTICE_LEAD_HOURS",
    3,
  );
  if (noticeLeadMs >= leadMs) {
    throw new NotConfigured(
      "UNCONFIRMED_NOTICE_LEAD_HOURS must be shorter than REMINDER_LEAD_HOURS",
    );
  }
  const name = env.WHATSAPP_REMINDER_TEMPLATE?.trim();
  const template = name
    ? { name, language: env.WHATSAPP_REMINDER_TEMPLATE_LANG?.trim() || "pt_BR" }
    : null;
  if (enabled && !template && isCloudProvider(env.MESSAGING_PROVIDER)) {
    throw new NotConfigured(
      "WHATSAPP_REMINDER_TEMPLATE is required with MESSAGING_PROVIDER=cloud while reminders are on (Meta only delivers business-initiated messages as approved templates); set REMINDERS_ENABLED=false to run without reminders",
    );
  }
  return { enabled, leadMs, noticeLeadMs, template };
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
  // Fail fast before opening anything: an unpriced model would make the budget unenforceable.
  const pricing = assertConfiguredModelsPriced();
  const budgetUsd = agentBudgetUsd();
  const pool = makePool();
  return {
    pool,
    clock: systemClock,
    calendar: new GoogleCalendar(),
    messaging: buildMessaging(),
    receptionPhone,
    llm: buildLlm(),
    conversations: new DbConversationStore(pool),
    handoffAutoReleaseMs: handoffAutoReleaseMs(),
    budgetUsd,
    pricing,
  };
}

/** AGENT_BUDGET_USD (005 FR-510): unset/empty → default; anything but a positive number fails fast. */
export function agentBudgetUsd(raw = process.env.AGENT_BUDGET_USD): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_AGENT_BUDGET_USD;
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (!/^\d+(\.\d+)?$/.test(trimmed) || !Number.isFinite(value) || value <= 0) {
    throw new Error(`AGENT_BUDGET_USD must be a positive number of US dollars, got "${raw}"`);
  }
  return value;
}

export interface FallbackConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** FALLBACK_LLM_* (005 FR-513): all three → enabled, none → disabled, a partial set fails fast. */
export function fallbackConfig(env: NodeJS.ProcessEnv = process.env): FallbackConfig | null {
  const baseUrl = env.FALLBACK_LLM_BASE_URL || "";
  const apiKey = env.FALLBACK_LLM_API_KEY || "";
  const model = env.FALLBACK_LLM_MODEL || "";
  const set = [baseUrl, apiKey, model].filter((v) => v.length > 0).length;
  if (set === 0) return null;
  if (set < 3) {
    throw new Error(
      "FALLBACK_LLM_BASE_URL, FALLBACK_LLM_API_KEY and FALLBACK_LLM_MODEL must be set together (or none)",
    );
  }
  return { baseUrl, apiKey, model };
}

/** Primary Anthropic model, wrapped in FallbackLLM when a secondary provider is configured. */
export function buildLlm(env: NodeJS.ProcessEnv = process.env): AnthropicLLM | FallbackLLM {
  const fb = fallbackConfig(env);
  const primary = new AnthropicLLM({
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.ANTHROPIC_MODEL || undefined,
    // With a fallback, fail over at once instead of after the SDK's retries (~3 × timeout + backoff).
    ...(fb ? { maxRetries: 0 } : {}),
  });
  if (!fb) return primary;
  const timeout = Number(env.FALLBACK_LLM_TIMEOUT_MS);
  const secondary = new OpenAICompatibleLLM({
    ...fb,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
  });
  return new FallbackLLM(primary, secondary);
}

/** The models this process may call — each must have a price (005 FR-512). */
export function pricedModels(env: NodeJS.ProcessEnv = process.env): string[] {
  const fb = fallbackConfig(env);
  return [env.ANTHROPIC_MODEL || DEFAULT_MODEL, ...(fb ? [fb.model] : [])];
}

export function assertConfiguredModelsPriced(env: NodeJS.ProcessEnv = process.env) {
  const pricing = loadPricing();
  assertPriced(pricing, pricedModels(env));
  return pricing;
}

/** HANDOFF_AUTO_RELEASE_HOURS (optional): unset/invalid/<= 0 → never auto-release (FR-211). */
export function handoffAutoReleaseMs(
  raw = process.env.HANDOFF_AUTO_RELEASE_HOURS,
): number | undefined {
  const hours = Number(raw);
  if (!raw || !Number.isFinite(hours) || hours <= 0) return undefined;
  return hours * 60 * 60 * 1000;
}

export async function closeAgentDeps(deps: AgentDeps): Promise<void> {
  await deps.pool.end();
}

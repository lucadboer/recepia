import { FakeCalendar } from "../../src/adapters/fakes/fake-calendar";
import { FakeClock } from "../../src/adapters/fakes/fake-clock";
import { FakeConversationStore } from "../../src/adapters/fakes/fake-conversation-store";
import { FakeMessaging } from "../../src/adapters/fakes/fake-messaging";
import type { AgentDeps } from "../../src/agent/orchestrator";
import type { Pool } from "../../src/db/pool";
import type { LLMPort, LlmMessage } from "../../src/ports/llm-port";

export const AGENT_NOW = new Date("2026-06-15T12:00:00Z"); // Monday 09:00 local
export const RECEPTION = "+5511999999999";
export const DAY_END = "2026-06-15T18:00:00Z";

export interface AgentHarness {
  deps: AgentDeps;
  clock: FakeClock;
  calendar: FakeCalendar;
  messaging: FakeMessaging;
  conversations: FakeConversationStore;
}

export function makeAgent(
  pool: Pool,
  llm: LLMPort,
  clock = new FakeClock(AGENT_NOW),
): AgentHarness {
  const calendar = new FakeCalendar();
  const messaging = new FakeMessaging();
  const conversations = new FakeConversationStore();
  const deps: AgentDeps = {
    pool,
    clock,
    calendar,
    messaging,
    conversations,
    llm,
    receptionPhone: RECEPTION,
  };
  return { deps, clock, calendar, messaging, conversations };
}

/** Extract the most recent holdId a tool_result carried (mimics what a real LLM reads back). */
export function lastHoldId(messages: LlmMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    for (const c of msg.content) {
      if (c.type === "tool_result") {
        try {
          const parsed = JSON.parse(c.content) as { holdId?: string };
          if (parsed.holdId) return parsed.holdId;
        } catch {
          // not JSON / no holdId
        }
      }
    }
  }
  return "MISSING-HOLD";
}

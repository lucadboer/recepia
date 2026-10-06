import { AGENT_MAX_ITERATIONS, CLINIC_TIMEZONE } from "../config";
import type { Deps } from "../deps";
import type { ConversationStorePort } from "../ports/conversation-store-port";
import type { LLMPort, LlmContent } from "../ports/llm-port";
import { escalateToHuman } from "../tools/escalate-to-human";
import { hasConsent, recordConsent, recordOptOut } from "./consent";
import {
  appendMessage,
  appendUserText,
  boundState,
  emptyState,
  isProcessed,
  markEscalated,
  markProcessed,
  setAwaitingConsent,
} from "./conversation";
import { classifyIntent, isAffirmative } from "./intent";
import { reply } from "./reply";
import { summarizeHistory } from "./summary";
import { buildSystemPrompt } from "./system-prompt";
import { dispatchTool, type ToolContext } from "./tool-registry";
import { TOOL_NAMES, toolDefs } from "./tool-schemas";
import { triage } from "./triage";
import type { ConversationState, InboundMessage, LoopResult } from "./types";

/** Dependencies for the conversational layer: the deterministic Deps + the LLM and conversation store. */
export interface AgentDeps extends Deps {
  llm: LLMPort;
  conversations: ConversationStorePort;
}

type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };

function toolUsesOf(content: LlmContent[]): ToolUseBlock[] {
  return content.filter((c): c is ToolUseBlock => c.type === "tool_use");
}

function textOf(content: LlmContent[]): string {
  return content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/**
 * Drive one inbound patient message to a reply or an escalation. The LLM proposes;
 * only the deterministic tools write. Structural guardrails live in tool-registry;
 * this function adds idempotency, opt-out/opt-in, the deterministic triage backstop,
 * the consent gate before confirm, and the bounded loop.
 */
export async function handleInbound(deps: AgentDeps, msg: InboundMessage): Promise<LoopResult> {
  const now = deps.clock.now();
  // Bound the state on the way in (stale offered slots, oversized history) and on the
  // way out, so neither the LLM context nor the JSONB row grows without limit (T239).
  let state = boundState(
    (await deps.conversations.load(msg.phone)) ?? emptyState(msg.phone, now),
    now,
  );
  const persist = async (s: ConversationState): Promise<ConversationState> => {
    const bounded = boundState(s, now);
    await deps.conversations.save(bounded);
    return bounded;
  };

  // 1. Idempotency.
  if (isProcessed(state, msg.providerMessageId)) return { status: "noop" };
  state = markProcessed(state, msg.providerMessageId, now);
  state = appendUserText(state, msg.text, now);

  // 2. Opt-out fast path (LGPD "opt-out fácil").
  if (classifyIntent(msg.text) === "opt_out") {
    await recordOptOut(deps, msg.phone);
    state = setAwaitingConsent(state, false, now);
    state = await persist(state);
    await deps.messaging.sendMessage(msg.phone, reply.optedOut());
    return { status: "replied", reply: reply.optedOut() };
  }

  // 2b. Capture opt-in when we were awaiting it.
  if (state.awaitingConsent && isAffirmative(msg.text) && !(await hasConsent(deps, msg.phone))) {
    await recordConsent(deps, msg.phone);
    state = setAwaitingConsent(state, false, now);
  }

  // 3. Deterministic escalation triage — BEFORE the LLM ("escalar na dúvida").
  const triaged = triage(msg.text);
  if (triaged.escalate) {
    await escalateToHuman(deps, {
      reason: triaged.reason ?? "triage",
      phone: msg.phone,
      context: msg.text,
      summary: summarizeHistory(state.history),
    });
    state = markEscalated(state, now);
    state = await persist(state);
    await deps.messaging.sendMessage(msg.phone, reply.escalatedToReception());
    return { status: "escalated", reply: reply.escalatedToReception() };
  }

  // 4. Bounded LLM tool-use loop.
  const system = buildSystemPrompt({ now, timezone: CLINIC_TIMEZONE });
  let finalText: string | null = null;
  // "Confirmation delivered" must mean a confirmation message was REALLY sent to the
  // patient this turn — not merely that the confirm tool returned without error (an
  // idempotent re-confirm succeeds but sends nothing). So count patient-facing sends
  // made by the tools through a turn-scoped messaging wrapper, and use that below (T227).
  let patientMessagesSent = 0;
  const turnDeps: AgentDeps = {
    ...deps,
    messaging: {
      async sendMessage(to, body) {
        if (to === msg.phone) patientMessagesSent++;
        await deps.messaging.sendMessage(to, body);
      },
    },
  };
  let iterations = 0;
  while (iterations < AGENT_MAX_ITERATIONS) {
    iterations++;
    const turn = await deps.llm.turn({ system, tools: toolDefs, messages: state.history });
    state = appendMessage(state, { role: "assistant", content: turn.content }, now);

    const toolUses = toolUsesOf(turn.content);
    if (toolUses.length === 0) {
      finalText = textOf(turn.content);
      break;
    }

    const toolResults: LlmContent[] = [];
    for (const tu of toolUses) {
      // Consent gate: block confirm until opt-in is recorded (confirm_booking stamps
      // consent_at unconditionally, so this is the enforcement point).
      if (tu.name === TOOL_NAMES.confirm && !(await hasConsent(deps, msg.phone))) {
        state = setAwaitingConsent(state, true, now);
        toolResults.push({
          type: "tool_result",
          toolUseId: tu.id,
          content: reply.askConsent(),
          isError: true,
        });
        continue;
      }
      const ctx: ToolContext = { deps: turnDeps, phone: msg.phone, state, now };
      const dispatched = await dispatchTool(ctx, tu.name, tu.input);
      state = dispatched.state;
      toolResults.push({
        type: "tool_result",
        toolUseId: tu.id,
        content: dispatched.content,
        isError: dispatched.isError,
      });
    }
    state = appendMessage(state, { role: "user", content: toolResults }, now);
  }

  // A confirmation counts as delivered only if a patient-facing message actually went
  // out during the tool loop (a fresh confirm_booking). Idempotent re-confirms send
  // nothing, so the closing reply below must still reach the patient (T227).
  const confirmationDelivered = patientMessagesSent > 0;

  // 5. Loop exhausted without a final reply → escalate + pt-BR fallback.
  if (finalText === null) {
    await escalateToHuman(deps, {
      reason: "max_iterations",
      phone: msg.phone,
      context: `Conversa excedeu ${AGENT_MAX_ITERATIONS} iterações sem resposta final.`,
      summary: summarizeHistory(state.history),
    });
    state = markEscalated(state, now);
    state = await persist(state);
    // Don't tell the patient "couldn't complete" if a confirmation already went out (T227).
    if (!confirmationDelivered) {
      await deps.messaging.sendMessage(msg.phone, reply.couldNotComplete());
    }
    return { status: "max_iterations", reply: reply.couldNotComplete() };
  }

  const replyText = finalText.trim().length > 0 ? finalText : reply.couldNotComplete();
  state = await persist(state);
  // Suppress the closing send only when a confirmation was actually delivered: a
  // successful booking yields exactly one patient message (not two), and a re-confirm
  // that sent nothing still gets a reply (not zero) — T227.
  if (!confirmationDelivered) await deps.messaging.sendMessage(msg.phone, replyText);
  return { status: state.status === "escalated" ? "escalated" : "replied", reply: replyText };
}

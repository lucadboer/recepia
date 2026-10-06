import { AGENT_MAX_ITERATIONS, CLINIC_TIMEZONE } from "../config";
import type { Deps } from "../deps";
import { dispatchOutbox } from "../jobs/dispatch-outbox";
import type { ConversationStorePort } from "../ports/conversation-store-port";
import type { LLMPort, LlmContent } from "../ports/llm-port";
import { escalateToHuman } from "../tools/escalate-to-human";
import { hasConsent, recordConsent, recordOptOut } from "./consent";
import {
  appendMessage,
  appendUserText,
  boundState,
  emptyState,
  isAutoReleaseDue,
  isProcessed,
  markEscalated,
  markHandoffNoticed,
  markProcessed,
  resetConversation,
  setAwaitingConsent,
  shouldSendHandoffNotice,
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
  /**
   * Optional safety valve (FR-211): a handed-off conversation resumes autonomously after
   * this long if reception never released it. Unset = never (release is explicit).
   */
  handoffAutoReleaseMs?: number;
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
  // FR-212: a completed conversation starts fresh on the next message (dedupe ids kept).
  if (state.status === "completed") state = resetConversation(state, now);
  // FR-211 safety valve: optional auto-release of a handed-off conversation after a TTL.
  if (
    deps.handoffAutoReleaseMs !== undefined &&
    isAutoReleaseDue(state, now, deps.handoffAutoReleaseMs)
  ) {
    state = resetConversation(state, now);
  }
  // save() is a compare-and-swap on state.version (T240): the returned state carries the
  // new version so later saves in this turn chain correctly; a stale save throws
  // ConversationConflictError and the turn fails loudly (no retry, no patient message).
  const persist = (s: ConversationState): Promise<ConversationState> =>
    deps.conversations.save(boundState(s, now));
  // Deliver what the tools committed (confirmation / escalation rows in the outbox) BEFORE
  // our own patient-facing reply — only THIS conversation's rows (its confirmation and the
  // reception notice about it), so a slow provider never makes this patient wait on other
  // conversations' retries (those belong to the scheduled dispatcher). Always called AFTER a
  // successful compare-and-swap: a turn that lost the race delivers nothing (FR-214).
  const flushOutbox = async (): Promise<void> => {
    await dispatchOutbox(deps, { conversationPhone: msg.phone }).catch((err) => {
      console.error("[orchestrator] outbox dispatch failed", err);
    });
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

  // 2a. Handed off (FR-211): reception owns this conversation. No LLM, no second reception
  //     notification; at most one notice to the patient per interval. Only the opt-out
  //     fast path above runs while handed off (LGPD). Reception releases via the CLI.
  if (state.status === "escalated") {
    if (shouldSendHandoffNotice(state, now)) {
      state = markHandoffNoticed(state, now);
      state = await persist(state);
      await deps.messaging.sendMessage(msg.phone, reply.handedOff());
      return { status: "handed_off", reply: reply.handedOff() };
    }
    state = await persist(state); // records the processed id; stays silent
    return { status: "handed_off" };
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
      summary: summarizeHistory(state.history.slice(0, -1)), // the trigger itself is the context
    });
    state = markEscalated(state, now);
    state = await persist(state);
    await flushOutbox();
    await deps.messaging.sendMessage(msg.phone, reply.escalatedToReception());
    return { status: "escalated", reply: reply.escalatedToReception() };
  }

  // 4. Bounded LLM tool-use loop.
  const system = buildSystemPrompt({ now, timezone: CLINIC_TIMEZONE });
  let finalText: string | null = null;
  // A fresh confirm_booking commits the patient's confirmation into the outbox. That
  // deterministic message OWNS the patient reply for this turn (T227): the orchestrator
  // must not add its closing text on top, even if delivery is still pending (it is
  // retried by the outbox). Role-based flag from the tool, not a phone match (T235).
  let confirmationEnqueued = false;
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
    let escalatedThisTurn = false;
    for (const tu of toolUses) {
      // Once a tool handed the conversation off, nothing else in this response may run: a
      // confirm_booking after escalate_to_human would flip the status back to completed.
      if (escalatedThisTurn) {
        toolResults.push({
          type: "tool_result",
          toolUseId: tu.id,
          content: reply.toolCancelledAfterHandoff(),
          isError: true,
        });
        continue;
      }
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
      const ctx: ToolContext = { deps, phone: msg.phone, state, now };
      const dispatched = await dispatchTool(ctx, tu.name, tu.input);
      state = dispatched.state;
      confirmationEnqueued ||= dispatched.patientNotified;
      escalatedThisTurn ||= dispatched.escalated;
      toolResults.push({
        type: "tool_result",
        toolUseId: tu.id,
        content: dispatched.content,
        isError: dispatched.isError,
      });
    }
    state = appendMessage(state, { role: "user", content: toolResults }, now);

    // The model handed the conversation to reception: the autonomous attempt ENDS here.
    // No further LLM call (it could keep holding/confirming after the hand-off); the
    // patient gets the deterministic hand-off reply, not model text (T244).
    if (escalatedThisTurn) {
      state = await persist(state);
      await flushOutbox();
      if (confirmationEnqueued) return { status: "escalated" }; // the confirmation owns the reply
      await deps.messaging.sendMessage(msg.phone, reply.escalatedToReception());
      return { status: "escalated", reply: reply.escalatedToReception() };
    }
  }

  const confirmationDelivered = confirmationEnqueued;

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
    await flushOutbox();
    // Don't tell the patient "couldn't complete" if a confirmation already went out (T227).
    if (!confirmationDelivered) {
      await deps.messaging.sendMessage(msg.phone, reply.couldNotComplete());
    }
    return { status: "max_iterations", reply: reply.couldNotComplete() };
  }

  const replyText = finalText.trim().length > 0 ? finalText : reply.couldNotComplete();
  state = await persist(state);
  // Only after the compare-and-swap succeeded: deliver this turn's committed confirmation
  // BEFORE our own closing reply, so the patient reads the confirmation first.
  await flushOutbox();
  // Suppress the closing send only when a confirmation was actually delivered: a
  // successful booking yields exactly one patient message (not two), and a re-confirm
  // that sent nothing still gets a reply (not zero) — T227.
  if (!confirmationDelivered) await deps.messaging.sendMessage(msg.phone, replyText);
  return { status: state.status === "escalated" ? "escalated" : "replied", reply: replyText };
}

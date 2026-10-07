import { SpanKind } from "@opentelemetry/api";
import {
  AGENT_MAX_ITERATIONS,
  CLINIC_TIMEZONE,
  DEFAULT_AGENT_BUDGET_USD,
  isRoutineType,
} from "../config";
import type { Deps } from "../deps";
import { ConversationConflictError } from "../domain/errors";
import { dispatchOutbox } from "../jobs/dispatch-outbox";
import { costUsdFailClosed, loadPricing, type PricingTable } from "../llm/pricing";
import type { ConversationStorePort } from "../ports/conversation-store-port";
import type { LLMPort, LlmContent, LlmTurnInput, LlmTurnResult } from "../ports/llm-port";
import { log } from "../telemetry/logger";
import { maskPhone, messageRef, patientRef } from "../telemetry/pseudonym";
import {
  ATTR,
  type MaybeAttributes,
  markSpanFailed,
  SPAN,
  setAttributes,
  withSpan,
} from "../telemetry/tracing";
import { escalateToHuman } from "../tools/escalate-to-human";
import { hasConsent, recordConsent, recordOptOut } from "./consent";
import {
  addUsage,
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
  setPromptVersion,
  shouldSendHandoffNotice,
  stripThinking,
} from "./conversation";
import { classifyIntent, isAffirmative } from "./intent";
import { reply } from "./reply";
import { summarizeHistory } from "./summary";
import { buildSystemPrompt } from "./system-prompt";
import { dispatchTool, type ToolContext, type ToolDispatchResult } from "./tool-registry";
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
  /** Per-conversation estimated-cost budget in USD (005 FR-510). Default DEFAULT_AGENT_BUDGET_USD. */
  budgetUsd?: number;
  /** Pricing table for the budget. Default: src/llm/pricing.json. */
  pricing?: PricingTable;
}

let defaultPricing: PricingTable | null = null;
function pricingOf(deps: AgentDeps): PricingTable {
  if (deps.pricing) return deps.pricing;
  defaultPricing ??= loadPricing();
  return defaultPricing;
}

/**
 * Estimated USD of one model call; zero-usage calls (fakes) are free and never priced. Priced by
 * the served model, then the requested one, else at the table's highest rate (fail closed).
 */
function callCost(deps: AgentDeps, r: LlmTurnResult): number {
  const u = r.usage;
  if (!u || u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens === 0) return 0;
  return costUsdFailClosed(pricingOf(deps), [r.model, deps.llm.model], u, (m) =>
    log.warn({ event: "pricing.unknown_model", served: r.model, requested: deps.llm.model }, m),
  );
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

/** Tool names come from the model: keep them identifier-shaped and phone-free for telemetry. */
function telemetryToolName(name: string): string {
  const shaped = name.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 64);
  // Any long digit run in a model-chosen name is treated as a possible phone, glued or not.
  return shaped.replace(/\d{8,}/g, (m) => maskPhone(m)) || "unknown";
}

/** Only non-personal, validated tool arguments reach telemetry (FR-503). */
function telemetryToolArgs(input: unknown): MaybeAttributes {
  const i = (input ?? {}) as Record<string, unknown>;
  const start = typeof i.start === "string" ? new Date(i.start) : null;
  return {
    [ATTR.toolType]: typeof i.type === "string" && isRoutineType(i.type) ? i.type : undefined,
    [ATTR.toolSlotStart]: start && !Number.isNaN(start.getTime()) ? start.toISOString() : undefined,
  };
}

type ToolOutcome = "ok" | "rejected" | "error";
type ToolRejection = NonNullable<ToolDispatchResult["rejectedBy"]> | "consent" | "after_handoff";

interface ToolRun {
  content: string;
  isError: boolean;
  outcome: ToolOutcome;
  rejectedBy?: ToolRejection;
  errorType?: string;
}

/** Observed facts about a turn, set as it runs and copied onto the `agent.turn` span. */
interface TurnObservation {
  conversationStatus?: string;
  promptVersion?: string;
  conversationCostUsd?: number;
}

/**
 * Drive one inbound patient message to a reply or an escalation. The LLM proposes;
 * only the deterministic tools write. Structural guardrails live in tool-registry;
 * this function adds idempotency, opt-out/opt-in, the deterministic triage backstop,
 * the consent gate before confirm, and the bounded loop.
 */
export async function handleInbound(deps: AgentDeps, msg: InboundMessage): Promise<LoopResult> {
  return withSpan(
    SPAN.turn,
    { [ATTR.messageRef]: messageRef(msg.providerMessageId) },
    async (span) => {
      const seen: TurnObservation = {};
      const result = await runTurn(deps, msg, seen);
      setAttributes(span, {
        [ATTR.turnStatus]: result.status,
        [ATTR.conversationStatus]: seen.conversationStatus,
        [ATTR.promptVersion]: seen.promptVersion,
        [ATTR.conversationCostUsd]: seen.conversationCostUsd,
      });
      log.debug(
        {
          event: "turn.done",
          messageRef: messageRef(msg.providerMessageId),
          patient: patientRef(msg.phone),
          status: result.status,
          conversationStatus: seen.conversationStatus,
          promptVersion: seen.promptVersion,
        },
        "turn finished",
      );
      return result;
    },
  );
}

async function runTurn(
  deps: AgentDeps,
  msg: InboundMessage,
  seen: TurnObservation,
): Promise<LoopResult> {
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
  // Provider reasoning blocks are replayed only within this turn and never persisted (004 R1):
  // the history is edited between inbound turns, which would invalidate their signatures.
  const persist = async (s: ConversationState): Promise<ConversationState> => {
    const saved = await deps.conversations.save(stripThinking(boundState(s, now)));
    seen.conversationStatus = saved.status;
    seen.conversationCostUsd = saved.usage.costUsd;
    return saved;
  };
  // Deliver what the tools committed (confirmation / escalation rows in the outbox) BEFORE
  // our own patient-facing reply — only THIS conversation's rows (its confirmation and the
  // reception notice about it), so a slow provider never makes this patient wait on other
  // conversations' retries (those belong to the scheduled dispatcher). Always called AFTER a
  // successful compare-and-swap: a turn that lost the race delivers nothing (FR-214).
  const flushOutbox = async (): Promise<void> => {
    await dispatchOutbox(deps, { conversationPhone: msg.phone }).catch((err) => {
      log.error({ event: "outbox.flush_failed", err }, "outbox dispatch failed inside a turn");
    });
  };

  const loaded = state; // before this message touches it (see recordSpendOnFailure)
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

  // 4. Bounded LLM tool-use loop. The prompt version in effect is recorded on every call
  //    (FR-409) and, through the tools' audit payloads, on every model-initiated write.
  const prompt = buildSystemPrompt({ now, timezone: CLINIC_TIMEZONE });
  // Every write the model initiates from here on is audited with this prompt version.
  const turnDeps: AgentDeps = { ...deps, promptVersion: prompt.version };
  state = setPromptVersion(state, prompt.version, now);
  seen.promptVersion = prompt.version;
  // One `chat` span per model call with the GenAI attributes (FR-502); never content.
  const callModel = (input: LlmTurnInput): Promise<LlmTurnResult> =>
    withSpan(
      SPAN.chat(deps.llm.model ?? "unknown"),
      {
        [ATTR.genAiOperation]: "chat",
        [ATTR.genAiProvider]: deps.llm.provider,
        [ATTR.genAiRequestModel]: deps.llm.model,
        [ATTR.promptVersion]: prompt.version,
      },
      async (span) => {
        const r = await deps.llm.turn(input);
        const cost = callCost(deps, r);
        state = addUsage(
          state,
          { usage: r.usage, costUsd: cost, model: r.model ?? deps.llm.model },
          now,
        );
        setAttributes(span, {
          [ATTR.llmCostUsd]: cost,
          [ATTR.genAiResponseModel]: r.model,
          [ATTR.genAiProvider]: r.provider ?? deps.llm.provider,
          [ATTR.genAiInputTokens]: r.usage?.inputTokens,
          [ATTR.genAiOutputTokens]: r.usage?.outputTokens,
          [ATTR.genAiCacheReadTokens]: r.usage?.cacheReadTokens,
          [ATTR.genAiCacheWriteTokens]: r.usage?.cacheWriteTokens,
          [ATTR.genAiFinishReasons]: [r.stopReason],
        });
        if (r.model && r.model !== deps.llm.model) span.updateName(SPAN.chat(r.model));
        return r;
      },
      { kind: SpanKind.CLIENT },
    );
  const handOffModelTurn = async (
    reason: string,
    context: string,
    details?: Record<string, string | number | boolean>,
  ): Promise<LoopResult> => {
    await escalateToHuman(turnDeps, {
      reason,
      phone: msg.phone,
      context,
      summary: summarizeHistory(state.history),
      details,
    });
    state = markEscalated(state, now);
    state = await persist(state);
    await flushOutbox();
    await deps.messaging.sendMessage(msg.phone, reply.escalatedToReception());
    return { status: "escalated", reply: reply.escalatedToReception() };
  };
  /**
   * A model call that succeeded was paid for even if the turn fails afterwards (a later call or a
   * tool throws). Persist ONLY the usage onto the state as it was loaded — the message is not
   * marked processed, so a provider retry still runs the turn — otherwise retried partial turns
   * could spend past the budget (005 FR-510). Best effort: a concurrent save wins.
   */
  const recordSpendOnFailure = async (err: unknown): Promise<never> => {
    if (state.usage.calls > loaded.usage.calls && !(err instanceof ConversationConflictError)) {
      await deps.conversations
        .save(boundState({ ...loaded, usage: state.usage, updatedAt: now }, now))
        .catch(() => {});
    }
    throw err;
  };
  let finalText: string | null = null;
  // A fresh confirm_booking commits the patient's confirmation into the outbox. That
  // deterministic message OWNS the patient reply for this turn (T227): the orchestrator
  // must not add its closing text on top, even if delivery is still pending (it is
  // retried by the outbox). Role-based flag from the tool, not a phone match (T235).
  let confirmationEnqueued = false;
  let iterations = 0;
  const budgetUsd = deps.budgetUsd ?? DEFAULT_AGENT_BUDGET_USD;
  while (iterations < AGENT_MAX_ITERATIONS) {
    // Budget gate (FR-510), before every model call — the overrun is bounded by one call.
    if (state.usage.costUsd >= budgetUsd) {
      log.warn(
        {
          event: "budget.reached",
          costUsd: state.usage.costUsd,
          budgetUsd,
          calls: state.usage.calls,
        },
        "conversation budget reached",
      );
      if (confirmationEnqueued) {
        // The booking is done and its confirmation owns the reply: finish without the closing
        // model text instead of handing a completed conversation to reception.
        state = await persist(state);
        await flushOutbox();
        return { status: "replied" };
      }
      return handOffModelTurn(
        "budget_exceeded",
        `Conversa atingiu o limite de custo estimado (US$ ${state.usage.costUsd.toFixed(4)} de US$ ${budgetUsd.toFixed(2)}).`,
        { costUsd: Number(state.usage.costUsd.toFixed(6)), budgetUsd },
      );
    }
    iterations++;
    const turn = await callModel({
      system: prompt.text,
      systemCacheablePrefix: prompt.cacheablePrefixLength,
      tools: toolDefs,
      messages: state.history,
      promptVersion: prompt.version,
    }).catch(recordSpendOnFailure);
    state = appendMessage(state, { role: "assistant", content: turn.content }, now);

    const toolUses = toolUsesOf(turn.content);
    // The provider declined (safety layer): the turn is discarded — no tool from it may run
    // and the patient must not get an empty reply. Reception takes over (004 R1).
    if (turn.stopReason === "refusal") {
      const category = turn.stopDetails?.category ? `, categoria ${turn.stopDetails.category}` : "";
      return handOffModelTurn(
        "model_refusal",
        `O modelo recusou a solicitação (stop_reason=refusal${category}).`,
      );
    }
    // Output cut by the token budget while calling a tool: the input may be truncated, so it
    // is never executed. A cut-off TEXT answer is still a reply (handled below).
    if (turn.stopReason === "max_tokens" && toolUses.length > 0) {
      return handOffModelTurn(
        "model_truncated",
        "A resposta do modelo foi cortada (stop_reason=max_tokens) no meio de uma chamada de ferramenta.",
      );
    }
    if (toolUses.length === 0) {
      finalText = textOf(turn.content);
      break;
    }

    const toolResults: LlmContent[] = [];
    let escalatedThisTurn = false;
    const runTool = async (tu: ToolUseBlock): Promise<ToolRun> => {
      // Once a tool handed the conversation off, nothing else in this response may run: a
      // confirm_booking after escalate_to_human would flip the status back to completed.
      if (escalatedThisTurn) {
        return {
          content: reply.toolCancelledAfterHandoff(),
          isError: true,
          outcome: "rejected",
          rejectedBy: "after_handoff",
        };
      }
      // Consent gate: block confirm until opt-in is recorded (confirm_booking stamps
      // consent_at unconditionally, so this is the enforcement point).
      if (tu.name === TOOL_NAMES.confirm && !(await hasConsent(deps, msg.phone))) {
        state = setAwaitingConsent(state, true, now);
        return {
          content: reply.askConsent(),
          isError: true,
          outcome: "rejected",
          rejectedBy: "consent",
        };
      }
      const ctx: ToolContext = { deps: turnDeps, phone: msg.phone, state, now };
      const dispatched = await dispatchTool(ctx, tu.name, tu.input);
      state = dispatched.state;
      confirmationEnqueued ||= dispatched.patientNotified;
      escalatedThisTurn ||= dispatched.escalated;
      return {
        content: dispatched.content,
        isError: dispatched.isError,
        outcome: dispatched.rejectedBy ? "rejected" : dispatched.isError ? "error" : "ok",
        rejectedBy: dispatched.rejectedBy,
        errorType: dispatched.errorType,
      };
    };
    for (const tu of toolUses) {
      const toolName = telemetryToolName(tu.name);
      const run = await withSpan(
        SPAN.tool(toolName),
        {
          [ATTR.genAiOperation]: "execute_tool",
          [ATTR.genAiToolName]: toolName,
          ...telemetryToolArgs(tu.input),
        },
        async (span) => {
          const r = await runTool(tu);
          setAttributes(span, {
            [ATTR.toolOutcome]: r.outcome,
            [ATTR.toolRejectedBy]: r.rejectedBy,
            [ATTR.errorType]: r.errorType,
          });
          // A tool that failed is an error; a guardrail rejection is the system working.
          if (r.outcome === "error") markSpanFailed(span, r.errorType);
          return r;
        },
      );
      toolResults.push({
        type: "tool_result",
        toolUseId: tu.id,
        content: run.content,
        isError: run.isError,
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
    await escalateToHuman(turnDeps, {
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

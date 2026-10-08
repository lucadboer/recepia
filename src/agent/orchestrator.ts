import { SpanKind } from "@opentelemetry/api";
import {
  AGENT_MAX_ITERATIONS,
  CLINIC_TIMEZONE,
  DEFAULT_AGENT_BUDGET_USD,
  isRoutineType,
} from "../config.ts";
import { type CommittedWrite, committedTurnWrites } from "../db/repositories/audit-repo.ts";
import { getById, hasLiveHold } from "../db/repositories/booking-repo.ts";
import { pendingRemindersForPhone } from "../db/repositories/reminder-repo.ts";
import type { Deps } from "../deps.ts";
import { ConversationConflictError } from "../domain/errors.ts";
import { dispatchOutbox } from "../jobs/dispatch-outbox.ts";
import { costUsdFailClosed, loadPricing, type PricingTable } from "../llm/pricing.ts";
import type { ConversationStorePort, SaveOptions } from "../ports/conversation-store-port.ts";
import type { LLMPort, LlmContent, LlmTurnInput, LlmTurnResult } from "../ports/llm-port.ts";
import { log } from "../telemetry/logger.ts";
import { maskPhone, messageRef, patientRef } from "../telemetry/pseudonym.ts";
import {
  ATTR,
  type MaybeAttributes,
  markSpanFailed,
  SPAN,
  setAttributes,
  withSpan,
} from "../telemetry/tracing.ts";
import { removeEventOrNotify } from "../tools/booking-calendar.ts";
import { confirmAttendance } from "../tools/confirm-attendance.ts";
import { escalateToHuman } from "../tools/escalate-to-human.ts";
import { hasConsent, recordConsent, recordOptOut } from "./consent.ts";
import {
  addUsage,
  appendMessage,
  appendUserText,
  applyCommittedTurn,
  boundState,
  emptyState,
  isAutoReleaseDue,
  isProcessed,
  markCompleted,
  markEscalated,
  markHandoffNoticed,
  markProcessed,
  recordSurfacedBooking,
  resetConversation,
  setAwaitingConsent,
  setPromptVersion,
  shouldSendHandoffNotice,
  startTurn,
  stripThinking,
} from "./conversation.ts";
import { classifyIntent, isAffirmative, isStrictAffirmative } from "./intent.ts";
import { reply } from "./reply.ts";
import { summarizeHistory } from "./summary.ts";
import { buildSystemPrompt, reminderContextLine } from "./system-prompt.ts";
import { dispatchTool, type ToolContext, type ToolDispatchResult } from "./tool-registry.ts";
import { TOOL_NAMES, toolDefs } from "./tool-schemas.ts";
import { triage } from "./triage.ts";
import type { ConversationState, InboundMessage, LoopResult } from "./types.ts";

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

/**
 * A cancel or a reschedule removes the cancelled booking's calendar event after its commit; a turn
 * that died in between left the event behind (008 review). The replay finishes that removal —
 * idempotent, and a delete that keeps failing still becomes a reception notice.
 */
async function finishCalendarCleanup(
  deps: AgentDeps,
  committed: CommittedWrite[],
  phone: string,
  now: Date,
): Promise<void> {
  for (const w of committed) {
    if (w.action !== "booking_cancelled" || !w.entityId) continue;
    const cancelled = await getById(deps.pool, w.entityId);
    if (cancelled?.status === "cancelled") await removeEventOrNotify(deps, cancelled, phone, now);
  }
}

async function runTurn(
  deps: AgentDeps,
  msg: InboundMessage,
  seen: TurnObservation,
): Promise<LoopResult> {
  const now = deps.clock.now();
  // Bound the state on the way in (stale offered slots, oversized history) and on the
  // way out, so neither the LLM context nor the JSONB row grows without limit (T239).
  const stored = await deps.conversations.load(msg.phone);
  // When this conversation last changed before this message (007: a "sim" answers the agent's
  // latest question, not a reminder, if the agent spoke after the reminder went out).
  const lastActivityAt = stored?.updatedAt ?? null;
  let state = boundState(stored ?? emptyState(msg.phone, now), now);
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
  // A turn that lost its message to another worker saves nothing (008 fencing): the store checks
  // the lease inside the save's own transaction.
  const lease = deps.lease;
  const saveOpts: SaveOptions = lease ? { fence: (tx) => lease.fence(tx) } : {};
  const persist = async (s: ConversationState): Promise<ConversationState> => {
    const saved = await deps.conversations.save(stripThinking(boundState(s, now)), saveOpts);
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

  // A reply is an effect of this turn: only the message's owner sends it (008 review — the save's
  // fence does not cover what happens after later awaits, such as the outbox flush).
  const sendReply = async (text: string): Promise<void> => {
    await deps.lease?.fence();
    await deps.messaging.sendMessage(msg.phone, text);
  };

  const loaded = state; // before this message touches it (see recordSpendOnFailure)
  // 1. Idempotency.
  if (isProcessed(state, msg.providerMessageId)) return { status: "noop" };
  // Every write of this turn carries the message that caused it (008 replay guard): the durable
  // queue's id, unique across providers (the provider id outside the queue).
  const turnKey = msg.inboundMessageId ?? msg.providerMessageId;
  const msgDeps: AgentDeps = { ...deps, inboundMessageId: turnKey };
  // 1b. Replay guard (found by the chaos test): the durable queue re-runs a message whose worker
  //     died after the turn's tools committed but before this state was saved. If that turn
  //     already produced a final write, running it again would duplicate it (a second booking, a
  //     second hand-off): finish the message instead — the outbox still delivers what it committed
  //     — and leave the conversation as that turn would have saved it (a hand-off stays handed off).
  const committed = await committedTurnWrites(deps.pool, turnKey);
  if (committed.length > 0) {
    await finishCalendarCleanup(deps, committed, msg.phone, now);
    state = applyCommittedTurn(markProcessed(state, msg.providerMessageId, now), committed, now);
    state = await persist(state);
    await flushOutbox();
    if (state.status !== "escalated") return { status: "noop" };
    // The hand-off reply goes out after the save the crash prevented, so the patient has not had
    // it — unless a message that turn committed (a confirmation) owns the reply (T227).
    if (committed.some((w) => w.action !== "escalated")) return { status: "escalated" };
    await sendReply(reply.escalatedToReception());
    return { status: "escalated", reply: reply.escalatedToReception() };
  }
  state = startTurn(markProcessed(state, msg.providerMessageId, now), now); // 006 FR-603 clock
  state = appendUserText(state, msg.text, now);

  // 2. Opt-out fast path (LGPD "opt-out fácil").
  if (classifyIntent(msg.text) === "opt_out") {
    await recordOptOut(deps, msg.phone);
    state = setAwaitingConsent(state, false, now);
    state = await persist(state);
    await sendReply(reply.optedOut());
    return { status: "replied", reply: reply.optedOut() };
  }

  // 2a. Handed off (FR-211): reception owns this conversation. No LLM, no second reception
  //     notification; at most one notice to the patient per interval. Only the opt-out
  //     fast path above runs while handed off (LGPD). Reception releases via the CLI.
  if (state.status === "escalated") {
    if (shouldSendHandoffNotice(state, now)) {
      state = markHandoffNoticed(state, now);
      state = await persist(state);
      await sendReply(reply.handedOff());
      return { status: "handed_off", reply: reply.handedOff() };
    }
    state = await persist(state); // records the processed id; stays silent
    return { status: "handed_off" };
  }

  // 2b. Capture opt-in when we were awaiting it.
  let consentCaptured = false;
  if (state.awaitingConsent && isAffirmative(msg.text) && !(await hasConsent(deps, msg.phone))) {
    await recordConsent(deps, msg.phone);
    state = setAwaitingConsent(state, false, now);
    consentCaptured = true;
  }

  // 2c. Reply to an appointment reminder (007). A plain "sim" to the only pending reminder
  //     confirms attendance deterministically — no model call (FR-703). Anything else reaches the
  //     model with that appointment in context and counted as shown in this turn (FR-704).
  const pendingReminders = await pendingRemindersForPhone(deps.pool, msg.phone, now);
  const answersTheReminder =
    pendingReminders.length === 1 &&
    pendingReminders[0].reminderSentAt !== null &&
    (lastActivityAt === null ||
      lastActivityAt.getTime() <= pendingReminders[0].reminderSentAt.getTime());
  if (
    answersTheReminder &&
    !consentCaptured &&
    !state.awaitingConsent &&
    isStrictAffirmative(msg.text) &&
    !(await hasLiveHold(deps.pool, state.activeHoldIds, now))
  ) {
    await confirmAttendance(msgDeps, pendingReminders[0].id, msg.phone, "fast_path");
    state = markCompleted(state, now);
    state = await persist(state);
    await flushOutbox(); // the attendance reply committed with the change is the only message
    return { status: "replied" };
  }
  if (pendingReminders.length === 1) {
    state = recordSurfacedBooking(state, pendingReminders[0].id, now);
  }

  // 3. Deterministic escalation triage — BEFORE the LLM ("escalar na dúvida").
  const triaged = triage(msg.text);
  if (triaged.escalate) {
    await escalateToHuman(msgDeps, {
      reason: triaged.reason ?? "triage",
      phone: msg.phone,
      context: msg.text,
      summary: summarizeHistory(state.history.slice(0, -1)), // the trigger itself is the context
    });
    state = markEscalated(state, now);
    state = await persist(state);
    await flushOutbox();
    await sendReply(reply.escalatedToReception());
    return { status: "escalated", reply: reply.escalatedToReception() };
  }

  // 4. Bounded LLM tool-use loop. The prompt version in effect is recorded on every call
  //    (FR-409) and, through the tools' audit payloads, on every model-initiated write.
  const prompt = buildSystemPrompt({
    now,
    timezone: CLINIC_TIMEZONE,
    context: reminderContextLine(pendingReminders),
  });
  // Every write the model initiates from here on is audited with this prompt version.
  const turnDeps: AgentDeps = { ...msgDeps, promptVersion: prompt.version };
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
    await sendReply(reply.escalatedToReception());
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
        .save(boundState({ ...loaded, usage: state.usage, updatedAt: now }, now), saveOpts)
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
    // Still this worker's message? A turn that lost it stops before paying for another call (008).
    await deps.lease?.fence();
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
      // A turn that lost its message to another worker runs no tool (008): this check spares the
      // external effects (calendar), the write transactions re-check under a row lock.
      await deps.lease?.fence();
      // Consent gate: block confirm until opt-in is recorded (confirm_booking stamps
      // consent_at unconditionally, so this is the enforcement point).
      // A reschedule writes a new booking with the patient's data, so it needs consent too (006
      // FR-607); a cancel reduces data and does not.
      if (
        (tu.name === TOOL_NAMES.confirm || tu.name === TOOL_NAMES.rescheduleBooking) &&
        !(await hasConsent(deps, msg.phone))
      ) {
        state = setAwaitingConsent(state, true, now);
        return {
          content: reply.askConsent(),
          isError: true,
          outcome: "rejected",
          rejectedBy: "consent",
        };
      }
      const ctx: ToolContext = {
        deps: turnDeps,
        phone: msg.phone,
        state,
        now,
        inboundText: msg.text,
      };
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
      await sendReply(reply.escalatedToReception());
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
      await sendReply(reply.couldNotComplete());
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
  if (!confirmationDelivered) await sendReply(replyText);
  return { status: state.status === "escalated" ? "escalated" : "replied", reply: replyText };
}

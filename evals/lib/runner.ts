// Single-case runner (research R3, contract `runCase`): truncate + seed, build AgentDeps with
// fakes + the real DbConversationStore + a FakeClock at seed.now, drive handleInbound once per
// patient turn, and turn the outcome into Observations. Agent-level failures are observations;
// an infrastructure throw is recorded as an error and ends the execution.

import { performance } from "node:perf_hooks";
import { FakeCalendar } from "../../src/adapters/fakes/fake-calendar";
import { FakeClock } from "../../src/adapters/fakes/fake-clock";
import { FakeMessaging } from "../../src/adapters/fakes/fake-messaging";
import { LlmProviderError } from "../../src/adapters/llm/errors";
import { FallbackExhaustedError } from "../../src/adapters/llm/fallback-llm";
import { recordConsent, recordOptOut } from "../../src/agent/consent";
import { type AgentDeps, handleInbound } from "../../src/agent/orchestrator";
import { PROMPT_VERSION } from "../../src/agent/system-prompt";
import { TOOL_NAMES } from "../../src/agent/tool-schemas";
import { HOLD_TTL_MS } from "../../src/config";
import type { Pool } from "../../src/db/pool";
import { DbConversationStore } from "../../src/db/repositories/conversation-repo";
import type {
  LLMPort,
  LlmMessage,
  LlmTurnInput,
  LlmTurnResult,
  LlmUsage,
} from "../../src/ports/llm-port";
import { resetDb, seedConfirmed, seedHeld, seedOverride, seedRule } from "../../tests/helpers/db";
import type { Observations, ObservedToolCall } from "./assertions";
import {
  type ConversationStatus,
  type EvalCase,
  FOREIGN_PHONE,
  RECEPTION_PHONE,
} from "./case-schema";

export type Mode = "fake" | "live";

/** What a scripted stand-in may need that only exists after seeding. */
export interface CaseContext {
  caseId: string;
  patientPhone: string;
  foreignPhone: string;
  /** Id of a seeded `held` booking belonging to another phone, if the seed has one. */
  otherConversationHoldId: string | null;
}

export interface RunCaseOptions {
  pool: Pool;
  llm: LLMPort | ((ctx: CaseContext) => LLMPort);
  mode: Mode;
  rep?: number;
}

export interface ExecutionError {
  kind: "infrastructure" | "timeout" | "rate_limit" | "provider" | "connection";
  message: string;
}

export interface TranscriptLine {
  role: "patient" | "agent" | "reception";
  text: string;
}

export interface Execution {
  caseId: string;
  category: EvalCase["category"];
  rep: number;
  mode: Mode;
  promptVersion: string;
  observations: Observations;
  latency: { perTurnMs: number[]; totalMs: number };
  llm: { calls: number; perCallMs: number[]; usage: LlmUsage };
  errors: ExecutionError[];
  transcript: TranscriptLine[];
}

const ZERO: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** Wraps any LLMPort to record latency, usage and the raw exchange (for tool-call observation). */
export class MeasuringLLM implements LLMPort {
  readonly perCallMs: number[] = [];
  readonly inputs: LlmTurnInput[] = [];
  readonly results: LlmTurnResult[] = [];
  usage: LlmUsage = { ...ZERO };

  constructor(private readonly inner: LLMPort) {}

  async turn(input: LlmTurnInput): Promise<LlmTurnResult> {
    this.inputs.push(input);
    const t0 = performance.now();
    try {
      const res = await this.inner.turn(input);
      this.results.push(res);
      if (res.usage) {
        this.usage = {
          inputTokens: this.usage.inputTokens + res.usage.inputTokens,
          outputTokens: this.usage.outputTokens + res.usage.outputTokens,
          cacheReadTokens: this.usage.cacheReadTokens + res.usage.cacheReadTokens,
          cacheWriteTokens: this.usage.cacheWriteTokens + res.usage.cacheWriteTokens,
        };
      }
      return res;
    } finally {
      this.perCallMs.push(performance.now() - t0);
    }
  }

  get calls(): number {
    return this.inputs.length;
  }
}

/** Provider errors are counted, never scored as success (FR-405 error count). */
export function classifyError(e: unknown): ExecutionError {
  // Both providers failed: what matters for the metric is why the primary failed.
  if (e instanceof FallbackExhaustedError) {
    return { ...classifyError(e.primary), message: e.message };
  }
  const err = e as { name?: string; status?: number | null; message?: string };
  const message = err?.message ?? String(e);
  if (err?.name === "APIConnectionTimeoutError") return { kind: "timeout", message };
  if (err?.name === "APIConnectionError") return { kind: "connection", message };
  if (typeof err?.status === "number") {
    if (err.status === 429) return { kind: "rate_limit", message };
    if (err.status >= 500 || err.status === 408) return { kind: "provider", message };
  }
  if (e instanceof LlmProviderError && e.transient && e.status === null) {
    return { kind: /timeout/i.test(e.message) ? "timeout" : "connection", message };
  }
  return { kind: "infrastructure", message };
}

/** Truncate the mutable tables and apply the case seed (capacity, overrides, bookings, consent). */
export async function seedCase(pool: Pool, c: EvalCase, deps: AgentDeps): Promise<CaseContext> {
  await resetDb(pool);
  for (const r of c.seed.capacity) {
    await seedRule(pool, {
      weekday: r.weekday,
      startTime: r.start,
      endTime: r.end,
      capacity: r.capacity,
    });
  }
  for (const o of c.seed.overrides ?? []) {
    await seedOverride(pool, {
      date: o.date,
      startTime: o.start,
      endTime: o.end,
      capacity: o.capacity,
    });
  }
  const now = new Date(c.seed.now);
  let otherConversationHoldId: string | null = null;
  for (const [i, b] of (c.seed.bookings ?? []).entries()) {
    const seat = b.seat ?? i;
    if (b.status === "confirmed") {
      await seedConfirmed(pool, b.start, b.phone, seat);
    } else {
      await seedHeld(pool, b.start, b.phone, new Date(now.getTime() + HOLD_TTL_MS), seat);
      if (b.phone !== c.patient.phone && otherConversationHoldId === null) {
        const { rows } = await pool.query(
          "SELECT id FROM booking WHERE patient_phone = $1 AND start_ts = $2 AND status = 'held'",
          [b.phone, new Date(b.start)],
        );
        otherConversationHoldId = rows[0]?.id ?? null;
      }
    }
  }
  if (c.seed.consent === "opted_in") await recordConsent(deps, c.patient.phone, "eval_seed");
  if (c.seed.consent === "opted_out") await recordOptOut(deps, c.patient.phone, "eval_seed");
  return {
    caseId: c.id,
    patientPhone: c.patient.phone,
    foreignPhone: FOREIGN_PHONE,
    otherConversationHoldId,
  };
}

export async function runCase(c: EvalCase, opts: RunCaseOptions): Promise<Execution> {
  const { pool, mode } = opts;
  const clock = new FakeClock(new Date(c.seed.now));
  const calendar = new FakeCalendar();
  const messaging = new FakeMessaging();
  const conversations = new DbConversationStore(pool);
  const seedDeps: AgentDeps = {
    pool,
    clock,
    calendar,
    messaging,
    conversations,
    receptionPhone: RECEPTION_PHONE,
    llm: { turn: async () => ({ stopReason: "end_turn", content: [] }) },
  };
  const ctx = await seedCase(pool, c, seedDeps);
  const inner = typeof opts.llm === "function" ? opts.llm(ctx) : opts.llm;
  const llm = new MeasuringLLM(inner);
  const deps: AgentDeps = { ...seedDeps, llm };

  const errors: ExecutionError[] = [];
  const perTurnMs: number[] = [];
  const transcript: TranscriptLine[] = [];
  const t0 = performance.now();
  for (const [turnIndex, turn] of c.turns.entries()) {
    if (turn.delayMs) clock.advance(turn.delayMs);
    if (isTurnAware(inner)) inner.beginTurn(turnIndex);
    transcript.push({ role: "patient", text: turn.text });
    const sentBefore = messaging.sent.length;
    const started = performance.now();
    try {
      await handleInbound(deps, {
        phone: c.patient.phone,
        text: turn.text,
        providerMessageId: turn.id,
      });
    } catch (e) {
      errors.push(classifyError(e));
      perTurnMs.push(performance.now() - started);
      break;
    }
    perTurnMs.push(performance.now() - started);
    for (const m of messaging.sent.slice(sentBefore)) {
      transcript.push({ role: m.to === c.patient.phone ? "agent" : "reception", text: m.body });
    }
  }
  const totalMs = performance.now() - t0;

  const observations = await collectObservations(pool, c, {
    llm,
    calendar,
    messaging,
    conversations,
  });
  return {
    caseId: c.id,
    category: c.category,
    rep: opts.rep ?? 1,
    mode,
    promptVersion: PROMPT_VERSION,
    observations,
    latency: { perTurnMs, totalMs },
    llm: { calls: llm.calls, perCallMs: [...llm.perCallMs], usage: llm.usage },
    errors,
    transcript,
  };
}

/** A scripted LLM that must be told which inbound turn is starting (see evals/lib/script.ts). */
interface TurnAware {
  beginTurn(turnIndex: number): void;
}
function isTurnAware(llm: LLMPort): llm is LLMPort & TurnAware {
  return typeof (llm as Partial<TurnAware>).beginTurn === "function";
}

interface AuditRow {
  id: string;
  action: string;
  entity_id: string | null;
  payload: Record<string, unknown> | null;
  /** Phone of the booking the row points at (booking rows only). */
  booking_phone: string | null;
}

async function collectObservations(
  pool: Pool,
  c: EvalCase,
  parts: {
    llm: MeasuringLLM;
    calendar: FakeCalendar;
    messaging: FakeMessaging;
    conversations: DbConversationStore;
  },
): Promise<Observations> {
  const phone = c.patient.phone;
  // audit_log.id is a uuid: order by insertion time (each write is its own transaction, so
  // created_at is strictly increasing in practice; id only breaks exact ties). Seeded bookings
  // write no audit row (only the seeded consent does, through recordConsent/recordOptOut), so
  // every booking/hold/escalation row here was written by the agent during this execution.
  const { rows: audit } = await pool.query<AuditRow>(
    `SELECT a.id, a.action, a.entity_id, a.payload, b.patient_phone AS booking_phone
     FROM audit_log a LEFT JOIN booking b ON b.id = a.entity_id
     ORDER BY a.created_at, a.id`,
  );
  const state = await parts.conversations.load(phone);
  const history = state?.history ?? [];
  const toolCalls = collectToolCalls(parts.llm, history);

  // Holds/bookings/escalations of THIS conversation and THIS execution: audit rows only, so
  // seeded bookings (even for the patient's own phone) are never counted as agent writes.
  const holds = audit.filter((r) => r.action === "hold_created" && r.payload?.phone === phone);
  const bookings = audit.filter(
    (r) => r.action === "booking_confirmed" && r.booking_phone === phone,
  );
  const escalations = audit
    .filter((r) => r.action === "escalated" && (r.payload?.phone ?? phone) === phone)
    .map((r) => ({ reason: String(r.payload?.reason ?? "unspecified") }));

  // Consent in effect at each booking write, from the audit trail (append-only, ordered), and
  // writes that landed on another phone (the phone is injected from context, never from args).
  let consented = false;
  let writesWithoutConsent = 0;
  let foreignWrites = 0;
  for (const r of audit) {
    if (r.payload?.phone === phone && r.action === "consent_recorded") consented = true;
    if (r.payload?.phone === phone && r.action === "consent_revoked") consented = false;
    if (r.action === "hold_created" && r.payload?.phone !== phone) foreignWrites++;
    if (r.action === "booking_confirmed") {
      if (r.booking_phone !== phone) foreignWrites++;
      else if (!consented) writesWithoutConsent++;
    }
  }

  const offeredSlots = [...new Set(offeredFromHistory(parts.llm, history))];
  const heldStarts = holds.map((h) => String(h.payload?.start));

  return {
    toolCalls,
    writes: {
      holds: holds.length,
      bookings: bookings.length,
      calendarEvents: parts.calendar.createdCount,
      escalations: escalations.length,
    },
    escalations,
    offeredSlots,
    heldStarts,
    ownHoldIds: holds.map((h) => h.entity_id).filter((id): id is string => id !== null),
    writesWithoutConsent,
    status: (state?.status ?? "active") as ConversationStatus,
    messages: parts.messaging.sent.map((m) => ({ to: m.to, body: m.body })),
    patientPhone: phone,
    llmCalls: parts.llm.calls,
    foreignWrites,
  };
}

/**
 * Tool calls in order, from the model's responses (tool_use) paired with the tool_result the
 * orchestrator produced — found in a later LLM input of the same turn or, for the last
 * iteration (never sent back), in the persisted history.
 */
function collectToolCalls(llm: MeasuringLLM, history: LlmMessage[]): ObservedToolCall[] {
  const results = new Map<string, boolean>(); // toolUseId → ok
  const scan = (messages: LlmMessage[]) => {
    for (const m of messages) {
      for (const b of m.content) {
        if (b.type === "tool_result") results.set(b.toolUseId, !b.isError);
      }
    }
  };
  for (const input of llm.inputs) scan(input.messages);
  scan(history);
  const out: ObservedToolCall[] = [];
  for (const res of llm.results) {
    for (const b of res.content) {
      if (b.type === "tool_use")
        out.push({ name: b.name, input: b.input, ok: results.get(b.id) ?? false });
    }
  }
  return out;
}

/** Every start returned by get_availability, read from the tool_result contents. */
function offeredFromHistory(llm: MeasuringLLM, history: LlmMessage[]): string[] {
  const ids = new Set<string>();
  for (const res of llm.results) {
    for (const b of res.content)
      if (b.type === "tool_use" && b.name === TOOL_NAMES.availability) ids.add(b.id);
  }
  const starts: string[] = [];
  const seen = new Set<string>();
  const scan = (messages: LlmMessage[]) => {
    for (const m of messages) {
      for (const b of m.content) {
        if (b.type !== "tool_result" || !ids.has(b.toolUseId) || b.isError || seen.has(b.toolUseId))
          continue;
        seen.add(b.toolUseId);
        try {
          const parsed = JSON.parse(b.content) as { slots?: { start: string }[] };
          for (const s of parsed.slots ?? []) starts.push(s.start);
        } catch {
          // not JSON → nothing offered
        }
      }
    }
  };
  for (const input of llm.inputs) scan(input.messages);
  scan(history);
  return starts;
}

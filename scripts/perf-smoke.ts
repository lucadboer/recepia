/**
 * Performance smoke (CI gate, see .github/workflows/perf.yml).
 *
 * Boots the REAL webhook server + orchestrator + Postgres with fake LLM / Calendar / Messaging,
 * pushes N concurrent conversations that all try to book the same morning, and asserts:
 *   1. ZERO overbooking — no slot ends with more confirmed bookings than its capacity (hard gate);
 *   2. p95 turn latency under PERF_P95_BUDGET_MS (+10 % tolerance; soft gate, fails the job).
 * Writes perf-report.json and, in GitHub Actions, a Markdown summary.
 *
 * Numbers are produced by this script only — never hand-written anywhere (README "honesty").
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { FakeCalendar } from "../src/adapters/fakes/fake-calendar";
import { FakeMessaging } from "../src/adapters/fakes/fake-messaging";
import { recordConsent } from "../src/agent/consent";
import { type AgentDeps, handleInbound } from "../src/agent/orchestrator";
import { TOOL_NAMES } from "../src/agent/tool-schemas";
import type { InboundMessage } from "../src/agent/types";
import { assertDisposableDatabase } from "../src/db/disposable";
import { loadEnv } from "../src/db/env";
import { migrate } from "../src/db/migrate";
import { makePool } from "../src/db/pool";
import { DbConversationStore } from "../src/db/repositories/conversation-repo";
import { ConversationConflictError } from "../src/domain/errors";
import { createInboundWorker } from "../src/jobs/inbound-worker";
import { systemClock } from "../src/ports/clock";
import type { LLMPort, LlmTurnInput, LlmTurnResult } from "../src/ports/llm-port";
import { shutdownTelemetry } from "../src/telemetry/register";
import { createDurableEnqueue } from "../src/webhook/enqueue";
import { createWebhookServer } from "../src/webhook/server";

const CONVERSATIONS = Number(process.env.PERF_CONVERSATIONS ?? 40);
const WARMUP = Number(process.env.PERF_WARMUP ?? 5);
const REPETITIONS = Number(process.env.PERF_REPETITIONS ?? 2);
const P95_BUDGET_MS = Number(process.env.PERF_P95_BUDGET_MS ?? 1500);
const TOLERANCE = 1.1; // fail only when > 10 % over budget (runner jitter)
// Progress gate: latency and no-overbooking mean nothing if every booking attempt failed with a
// handled tool error (the orchestrator would just escalate). Require real bookings.
const MIN_CONFIRMED_RATIO = Number(process.env.PERF_MIN_CONFIRMED_RATIO ?? 0.5);
const CAPACITY = 2;
const SECRET = "perf-smoke-secret";

// ---------------------------------------------------------------------------
// A stateless scripted "LLM" that books: availability → hold → confirm → done.
// It reads the previous tool_result to decide the next tool call; on a hold error it
// re-checks availability and tries the next slot. The conversation's own message text
// carries an index so different patients prefer different slots (spreads the race while
// still colliding on popular ones).
// ---------------------------------------------------------------------------
export class BookingScriptLLM implements LLMPort {
  readonly model = "scripted-booking";
  readonly provider = "fake";

  async turn(input: LlmTurnInput): Promise<LlmTurnResult> {
    const first = input.messages[0]?.content.find((c) => c.type === "text");
    const idx = first && first.type === "text" ? Number(/#(\d+)/.exec(first.text)?.[1] ?? 0) : 0;
    const last = input.messages.at(-1);
    const results = (last?.content ?? []).filter((c) => c.type === "tool_result");
    const tried = new Set<string>();
    for (const m of input.messages) {
      for (const c of m.content) {
        if (c.type === "tool_use" && c.name === TOOL_NAMES.hold) {
          tried.add(String((c.input as { start?: string })?.start));
        }
      }
    }
    const availability = (): LlmTurnResult => ({
      stopReason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: `tu_av_${input.messages.length}`,
          name: TOOL_NAMES.availability,
          input: {
            from: new Date(Date.now() + 2 * 3600_000).toISOString(),
            to: new Date(Date.now() + 10 * 24 * 3600_000).toISOString(),
            type: "cleaning",
          },
        },
      ],
    });
    if (results.length === 0) return availability();
    const r = results[0];
    if (r.type !== "tool_result") return availability();
    let parsed: { slots?: { start: string }[]; holdId?: string; bookingId?: string } | null = null;
    try {
      parsed = JSON.parse(r.content);
    } catch {
      parsed = null;
    }
    if (parsed?.slots) {
      const candidates = parsed.slots.filter((s) => !tried.has(s.start));
      if (candidates.length === 0)
        return { stopReason: "end_turn", content: [{ type: "text", text: "Sem horários." }] };
      const pick = candidates[idx % Math.min(candidates.length, 4)]; // prefer one of the first 4 → real collisions
      return {
        stopReason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: `tu_hold_${input.messages.length}`,
            name: TOOL_NAMES.hold,
            input: { start: pick.start, type: "cleaning" },
          },
        ],
      };
    }
    if (parsed?.holdId) {
      return {
        stopReason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: `tu_conf_${input.messages.length}`,
            name: TOOL_NAMES.confirm,
            input: { hold_id: parsed.holdId, patient_name: "Carga" },
          },
        ],
      };
    }
    if (parsed?.bookingId)
      return { stopReason: "end_turn", content: [{ type: "text", text: "Confirmado!" }] };
    if (r.isError) return availability(); // slot just filled → look again
    return { stopReason: "end_turn", content: [{ type: "text", text: "ok" }] };
  }
}

/** Nearest-rank percentile over an ascending array (p in 0..100). Empty → 0. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}

interface RunResult {
  conversations: number;
  turnP50Ms: number;
  turnP95Ms: number;
  ackP50Ms: number;
  ackP95Ms: number;
  wallMs: number;
  statuses: Record<string, number>;
  errors: number;
  conflicts: number;
  confirmedBookings: number;
  overbookedSlots: number;
}

// The smoke TRUNCATEs every mutable table; the guard lives in src/db/disposable.ts (shared with
// the eval harness) and is re-exported here for the unit tests.
export { assertDisposableDatabase };

async function runOnce(rep: number): Promise<RunResult> {
  loadEnv();
  assertDisposableDatabase(process.env.DATABASE_URL);
  const pool = makePool();
  await migrate(pool);
  const client = await pool.connect();
  try {
    await client.query("ALTER TABLE audit_log DISABLE TRIGGER USER");
    await client.query(
      "TRUNCATE booking, audit_log, capacity_rule, capacity_override, patient_consent, conversation_state, outbox_message, inbound_message RESTART IDENTITY",
    );
  } finally {
    await client.query("ALTER TABLE audit_log ENABLE TRIGGER USER").catch(() => {});
    client.release();
  }
  for (let wd = 0; wd <= 6; wd++) {
    await pool.query(
      "INSERT INTO capacity_rule (weekday, start_time, end_time, capacity) VALUES ($1, '09:00', '18:00', $2)",
      [wd, CAPACITY],
    );
  }

  const messaging = new FakeMessaging();
  const deps: AgentDeps = {
    pool,
    clock: systemClock,
    calendar: new FakeCalendar(),
    messaging,
    receptionPhone: "+5511999990000",
    llm: new BookingScriptLLM(),
    conversations: new DbConversationStore(pool),
  };

  const turnMs: number[] = [];
  const statuses: Record<string, number> = {};
  let errors = 0;
  let conflicts = 0;
  // 008: the webhook stores each message; the worker runs the turns (FIFO per phone).
  const worker = createInboundWorker({
    pool,
    clock: systemClock,
    receptionPhone: deps.receptionPhone,
    pollMs: 20,
    handler: async (msg: InboundMessage) => {
      const t0 = performance.now();
      try {
        const r = await handleInbound(deps, msg);
        turnMs.push(performance.now() - t0);
        statuses[r.status] = (statuses[r.status] ?? 0) + 1;
        return r;
      } catch (err) {
        if (err instanceof ConversationConflictError) conflicts++;
        else errors++;
        throw err; // the worker retries it
      }
    },
  });
  const server = createWebhookServer({
    secret: SECRET,
    enqueue: createDurableEnqueue({ pool, clock: systemClock, onStored: () => worker.wake() }),
    onError: () => {
      errors++;
    },
  });
  worker.start();
  /** Every stored message reached a terminal state (or the budget ran out). */
  const queueSettled = async (budgetMs: number): Promise<boolean> => {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM inbound_message WHERE status IN ('pending','processing')",
      );
      if (rows[0].n === 0) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  };
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/webhook/evolution/${SECRET}`;
  const headers = { "content-type": "application/json", authorization: SECRET };
  const post = (phoneDigits: string, id: string, text: string) =>
    fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        event: "messages.upsert",
        data: {
          key: { remoteJid: `${phoneDigits}@s.whatsapp.net`, fromMe: false, id },
          message: { conversation: text },
        },
      }),
    });

  // Consent is a precondition for confirm_booking; record it so the run measures booking, not opt-in.
  const phones = Array.from(
    { length: CONVERSATIONS + WARMUP },
    (_, i) => `55119${String(900000 + rep * 1000 + i).padStart(6, "0")}`,
  );
  for (const p of phones) await recordConsent(deps, `+${p}`);

  // Warm-up (excluded from the measurement).
  for (let i = 0; i < WARMUP; i++) await post(phones[i], `w${rep}-${i}`, `aquecimento #${i}`);
  await queueSettled(60_000);
  turnMs.length = 0;
  for (const k of Object.keys(statuses)) delete statuses[k];

  // Measured burst: all conversations arrive at once.
  const ackMs: number[] = [];
  const wall0 = performance.now();
  await Promise.all(
    phones.slice(WARMUP).map(async (p, i) => {
      const t0 = performance.now();
      const res = await post(p, `m${rep}-${i}`, `quero marcar uma limpeza #${i}`);
      ackMs.push(performance.now() - t0);
      if (res.status !== 200) errors++;
    }),
  );
  const drained = await queueSettled(120_000);
  const wallMs = performance.now() - wall0;
  if (!drained) errors++;
  await worker.drain(10_000);

  const over = await pool.query(
    `SELECT start_ts, count(*)::int AS n FROM booking
     WHERE status IN ('confirmed','patient_confirmed','done')
     GROUP BY start_ts HAVING count(*) > $1`,
    [CAPACITY],
  );
  // Only the MEASURED conversations count as confirmed (warm-up bookings are excluded).
  const confirmed = await pool.query(
    `SELECT count(*)::int AS n FROM booking
     WHERE status IN ('confirmed','patient_confirmed','done')
       AND patient_phone = ANY($1::text[])`,
    [phones.slice(WARMUP).map((p) => `+${p}`)],
  );

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();

  const sortedTurn = [...turnMs].sort((a, b) => a - b);
  const sortedAck = [...ackMs].sort((a, b) => a - b);
  return {
    conversations: CONVERSATIONS,
    turnP50Ms: Math.round(percentile(sortedTurn, 50)),
    turnP95Ms: Math.round(percentile(sortedTurn, 95)),
    ackP50Ms: Math.round(percentile(sortedAck, 50)),
    ackP95Ms: Math.round(percentile(sortedAck, 95)),
    wallMs: Math.round(wallMs),
    statuses,
    errors,
    conflicts,
    confirmedBookings: confirmed.rows[0].n,
    overbookedSlots: over.rows.length,
  };
}

export interface Verdict {
  noOverbooking: boolean;
  withinBudget: boolean;
  noErrors: boolean;
  /** Every measured conversation reached a terminal status (none vanished). */
  allTurnsAccounted: boolean;
  /** At least `minConfirmedRatio` of the measured conversations really booked. */
  enoughBookings: boolean;
  pass: boolean;
}

/** Pure verdict over the collected runs — unit-tested; the gate is only as good as this. */
export function evaluateVerdict(
  runs: RunResult[],
  opts: { p95BudgetMs: number; tolerance: number; minConfirmedRatio: number },
): { medianP95: number; overbooked: number; errors: number; verdict: Verdict } {
  const sortedP95 = [...runs.map((r) => r.turnP95Ms)].sort((a, b) => a - b);
  const medianP95 = runs.length === 0 ? 0 : sortedP95[Math.floor(runs.length / 2)];
  const overbooked = runs.reduce((n, r) => n + r.overbookedSlots, 0);
  const errors = runs.reduce((n, r) => n + r.errors, 0);
  const allTurnsAccounted =
    runs.length > 0 &&
    runs.every((r) => Object.values(r.statuses).reduce((a, b) => a + b, 0) === r.conversations);
  const enoughBookings =
    runs.length > 0 &&
    runs.every((r) => r.confirmedBookings >= Math.ceil(r.conversations * opts.minConfirmedRatio));
  const verdict: Verdict = {
    noOverbooking: overbooked === 0,
    withinBudget: medianP95 <= opts.p95BudgetMs * opts.tolerance,
    noErrors: errors === 0,
    allTurnsAccounted,
    enoughBookings,
    pass: false,
  };
  verdict.pass =
    verdict.noOverbooking &&
    verdict.withinBudget &&
    verdict.noErrors &&
    verdict.allTurnsAccounted &&
    verdict.enoughBookings;
  return { medianP95, overbooked, errors, verdict };
}

async function main(): Promise<void> {
  const runs: RunResult[] = [];
  for (let rep = 0; rep < REPETITIONS; rep++) runs.push(await runOnce(rep));
  const { medianP95, overbooked, errors, verdict } = evaluateVerdict(runs, {
    p95BudgetMs: P95_BUDGET_MS,
    tolerance: TOLERANCE,
    minConfirmedRatio: MIN_CONFIRMED_RATIO,
  });
  const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    conversationsPerRun: CONVERSATIONS,
    repetitions: REPETITIONS,
    capacityPerSlot: CAPACITY,
    budget: {
      turnP95Ms: P95_BUDGET_MS,
      toleranceFactor: TOLERANCE,
      minConfirmedRatio: MIN_CONFIRMED_RATIO,
    },
    medianTurnP95Ms: medianP95,
    overbookedSlots: overbooked,
    errors,
    runs,
    verdict,
  };
  writeFileSync(
    process.env.PERF_REPORT_PATH ?? "perf-report.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );

  const statusesOf = (r: RunResult) =>
    Object.entries(r.statuses)
      .map(([k, v]) => `${k}:${v}`)
      .join(" ") || "—";
  const md = [
    "## Perf smoke (fakes for LLM/Calendar/WhatsApp, real Postgres)",
    "",
    `Conversations per run: ${CONVERSATIONS} · repetitions: ${REPETITIONS} · capacity per slot: ${CAPACITY}`,
    "",
    "| run | turn p50 | turn p95 | ack p50 | ack p95 | wall | confirmed | turn statuses | overbooked slots | conflicts | errors |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...runs.map(
      (r, i) =>
        `| ${i + 1} | ${r.turnP50Ms} ms | ${r.turnP95Ms} ms | ${r.ackP50Ms} ms | ${r.ackP95Ms} ms | ${r.wallMs} ms | ${r.confirmedBookings}/${r.conversations} | ${statusesOf(r)} | ${r.overbookedSlots} | ${r.conflicts} | ${r.errors} |`,
    ),
    "",
    `Median turn p95: **${medianP95} ms** (budget ${P95_BUDGET_MS} ms, tolerance ×${TOLERANCE}) · overbooked slots: **${overbooked}** · errors: ${errors} · min confirmed ratio: ${MIN_CONFIRMED_RATIO}`,
    "",
    `Verdict: **${verdict.pass ? "PASS" : "FAIL"}** — no overbooking: ${verdict.noOverbooking} · within budget: ${verdict.withinBudget} · no errors: ${verdict.noErrors} · all turns accounted: ${verdict.allTurnsAccounted} · enough bookings: ${verdict.enoughBookings}`,
  ].join("\n");
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const prev = (() => {
      try {
        return readFileSync(process.env.GITHUB_STEP_SUMMARY, "utf8");
      } catch {
        return "";
      }
    })();
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${prev}${md}\n`);
  }

  if (!verdict.noOverbooking) {
    console.error(`FAIL: ${overbooked} slot(s) over capacity — no-overbooking guarantee broken`);
  }
  if (!verdict.noErrors) console.error(`FAIL: ${errors} error(s) during the run`);
  if (!verdict.allTurnsAccounted) {
    console.error("FAIL: some measured conversations never reached a terminal status");
  }
  if (!verdict.enoughBookings) {
    console.error(
      `FAIL: fewer than ${MIN_CONFIRMED_RATIO * 100}% of the measured conversations booked — the workload did not exercise the booking path`,
    );
  }
  if (!verdict.withinBudget) {
    console.error(`FAIL: median turn p95 ${medianP95} ms > ${P95_BUDGET_MS} ms × ${TOLERANCE}`);
  }
  // Flush the spans of the last turns before exiting (no-op when tracing is off).
  await shutdownTelemetry();
  if (!verdict.pass) process.exit(1);
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeCalendar } from "../../src/adapters/fakes/fake-calendar";
import { FakeClock } from "../../src/adapters/fakes/fake-clock";
import { FakeMessaging } from "../../src/adapters/fakes/fake-messaging";
import type { Pool } from "../../src/db/pool";
import { cancelPendingForRecipient, enqueueOutbox } from "../../src/db/repositories/outbox-repo";
import type { Deps } from "../../src/deps";
import {
  dispatchOutbox,
  OUTBOX_BACKOFF_MS,
  OUTBOX_MAX_ATTEMPTS,
} from "../../src/jobs/dispatch-outbox";
import { withSpan } from "../../src/telemetry/tracing";
import { countAudit, ensureSchema, resetDb, testPool } from "../helpers/db";
import { startTestTelemetry, type TestTelemetry } from "../helpers/telemetry";

const NOW = new Date("2026-06-15T12:00:00Z");
const RECEPTION = "+5511999999999";
const PATIENT = "+5531988887777";

let pool: Pool;

beforeAll(async () => {
  pool = testPool();
  await ensureSchema(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await resetDb(pool);
});

function makeDeps(clock: FakeClock, messaging: FakeMessaging): Deps {
  return { pool, clock, calendar: new FakeCalendar(), messaging, receptionPhone: RECEPTION };
}

interface OutboxRow {
  id: string;
  kind: string;
  to_phone: string;
  body: string;
  status: string;
  attempts: number;
  next_attempt_at: Date;
  last_error: string | null;
  sent_at: Date | null;
}
async function rows(): Promise<OutboxRow[]> {
  const r = await pool.query("SELECT * FROM outbox_message ORDER BY created_at, id");
  return r.rows as OutboxRow[];
}

describe("outbox — enqueue (T241, FR-214)", () => {
  it("enqueues a pending row due now and returns its id", async () => {
    const id = await enqueueOutbox(pool, {
      kind: "booking_confirmation",
      toPhone: PATIENT,
      body: "Sua consulta está confirmada.",
      dedupeKey: "booking_confirmation:b1",
      now: NOW,
    });
    expect(id).toBeTruthy();
    const [r] = await rows();
    expect(r.status).toBe("pending");
    expect(r.attempts).toBe(0);
    expect(r.to_phone).toBe(PATIENT);
    expect(new Date(r.next_attempt_at).getTime()).toBeLessThanOrEqual(NOW.getTime());
  });

  it("dedupes on dedupe_key: the second enqueue returns null and writes no row", async () => {
    const first = await enqueueOutbox(pool, {
      kind: "booking_confirmation",
      toPhone: PATIENT,
      body: "x",
      dedupeKey: "booking_confirmation:b1",
      now: NOW,
    });
    const second = await enqueueOutbox(pool, {
      kind: "booking_confirmation",
      toPhone: PATIENT,
      body: "x",
      dedupeKey: "booking_confirmation:b1",
      now: NOW,
    });
    expect(first).toBeTruthy();
    expect(second).toBeNull();
    expect(await rows()).toHaveLength(1);
  });

  it("rows without a dedupe key are independent", async () => {
    await enqueueOutbox(pool, { kind: "escalation", toPhone: RECEPTION, body: "a", now: NOW });
    await enqueueOutbox(pool, { kind: "escalation", toPhone: RECEPTION, body: "b", now: NOW });
    expect(await rows()).toHaveLength(2);
  });
});

describe("outbox — dispatch (T241, FR-214)", () => {
  it("delivers a due row exactly once and marks it sent", async () => {
    const clock = new FakeClock(NOW);
    const messaging = new FakeMessaging();
    await enqueueOutbox(pool, {
      kind: "booking_confirmation",
      toPhone: PATIENT,
      body: "Confirmado!",
      now: NOW,
    });

    const r1 = await dispatchOutbox(makeDeps(clock, messaging));
    expect(r1).toEqual({ sent: 1, retried: 0, failed: 0 });
    expect(messaging.sent).toEqual([{ to: PATIENT, body: "Confirmado!" }]);
    const [row] = await rows();
    expect(row.status).toBe("sent");
    expect(row.sent_at).not.toBeNull();
    expect(row.attempts).toBe(1);

    // Nothing left to do; no second delivery.
    const r2 = await dispatchOutbox(makeDeps(clock, messaging));
    expect(r2).toEqual({ sent: 0, retried: 0, failed: 0 });
    expect(messaging.sent).toHaveLength(1);
  });

  it("leaves rows that are not yet due untouched", async () => {
    const clock = new FakeClock(NOW);
    const messaging = new FakeMessaging();
    await enqueueOutbox(pool, {
      kind: "escalation",
      toPhone: RECEPTION,
      body: "later",
      now: new Date(NOW.getTime() + 60_000), // due in 1 min
    });
    const r = await dispatchOutbox(makeDeps(clock, messaging));
    expect(r.sent).toBe(0);
    expect(messaging.sent).toHaveLength(0);
    clock.advance(61_000);
    const r2 = await dispatchOutbox(makeDeps(clock, messaging));
    expect(r2.sent).toBe(1);
  });

  it("on a send failure schedules a retry with backoff and keeps the row pending", async () => {
    const clock = new FakeClock(NOW);
    const messaging = new FakeMessaging();
    messaging.failTimes = 1;
    await enqueueOutbox(pool, {
      kind: "booking_confirmation",
      toPhone: PATIENT,
      body: "Confirmado!",
      now: NOW,
    });

    const r = await dispatchOutbox(makeDeps(clock, messaging));
    expect(r).toEqual({ sent: 0, retried: 1, failed: 0 });
    const [row] = await rows();
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain("messaging down");
    expect(new Date(row.next_attempt_at).getTime()).toBe(NOW.getTime() + OUTBOX_BACKOFF_MS[0]);

    // Not due yet → skipped; due after the backoff → delivered.
    expect((await dispatchOutbox(makeDeps(clock, messaging))).sent).toBe(0);
    clock.advance(OUTBOX_BACKOFF_MS[0]);
    expect((await dispatchOutbox(makeDeps(clock, messaging))).sent).toBe(1);
    expect(messaging.sent).toEqual([{ to: PATIENT, body: "Confirmado!" }]);
    expect((await rows())[0].status).toBe("sent");
  });

  it("dead-letters after OUTBOX_MAX_ATTEMPTS: failed + audit + escalation row for reception", async () => {
    const clock = new FakeClock(NOW);
    const messaging = new FakeMessaging();
    messaging.failAlways = true;
    await enqueueOutbox(pool, {
      kind: "booking_confirmation",
      toPhone: PATIENT,
      body: "Confirmado!",
      dedupeKey: "booking_confirmation:b9",
      now: NOW,
    });

    let result = { sent: 0, retried: 0, failed: 0 };
    for (let attempt = 1; attempt <= OUTBOX_MAX_ATTEMPTS; attempt++) {
      result = await dispatchOutbox(makeDeps(clock, messaging));
      const backoff = OUTBOX_BACKOFF_MS[Math.min(attempt - 1, OUTBOX_BACKOFF_MS.length - 1)];
      clock.advance(backoff);
    }
    // The 6th call dead-letters the confirmation AND, in the same batch, already attempts
    // the freshly enqueued escalation (which also fails here → retried, still pending).
    expect(result.failed).toBe(1);
    expect(result.sent).toBe(0);

    const all = await rows();
    const dead = all.find((r) => r.kind === "booking_confirmation");
    expect(dead?.status).toBe("failed");
    expect(dead?.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    expect(await countAudit(pool, "outbox_dead_letter")).toBe(1);
    const audit = await pool.query(
      "SELECT payload FROM audit_log WHERE action = 'outbox_dead_letter'",
    );
    expect(audit.rows[0].payload.kind).toBe("booking_confirmation");
    expect(audit.rows[0].payload.toPhone).toBe(PATIENT);
    expect(audit.rows[0].payload.attempts).toBe(OUTBOX_MAX_ATTEMPTS);

    // Reception is told that the patient could not be reached (an escalation row, pending).
    const esc = all.find((r) => r.kind === "escalation");
    expect(esc?.to_phone).toBe(RECEPTION);
    expect(esc?.status).toBe("pending");
    expect(await countAudit(pool, "escalated")).toBe(1);
  });

  it("a dead-lettered escalation only audits — no infinite escalation loop", async () => {
    const clock = new FakeClock(NOW);
    const messaging = new FakeMessaging();
    messaging.failAlways = true;
    await enqueueOutbox(pool, { kind: "escalation", toPhone: RECEPTION, body: "help", now: NOW });

    for (let attempt = 1; attempt <= OUTBOX_MAX_ATTEMPTS; attempt++) {
      await dispatchOutbox(makeDeps(clock, messaging));
      clock.advance(OUTBOX_BACKOFF_MS[Math.min(attempt - 1, OUTBOX_BACKOFF_MS.length - 1)]);
    }
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("failed");
    expect(await countAudit(pool, "outbox_dead_letter")).toBe(1);
    expect(await countAudit(pool, "escalated")).toBe(0);
  });

  it("two concurrent dispatchers deliver each of N rows exactly once (SKIP LOCKED)", async () => {
    const clock = new FakeClock(NOW);
    const messaging = new FakeMessaging();
    for (let i = 0; i < 10; i++) {
      await enqueueOutbox(pool, {
        kind: "escalation",
        toPhone: RECEPTION,
        body: `m${i}`,
        now: NOW,
      });
    }
    const deps = makeDeps(clock, messaging);
    const [a, b] = await Promise.all([
      dispatchOutbox(deps, { batchSize: 10 }),
      dispatchOutbox(deps, { batchSize: 10 }),
    ]);
    expect(a.sent + b.sent).toBe(10);
    expect(messaging.sent).toHaveLength(10);
    expect(new Set(messaging.sent.map((m) => m.body)).size).toBe(10);
    expect((await rows()).every((r) => r.status === "sent")).toBe(true);
  });

  it("a conversationPhone filter delivers only that conversation's rows (its confirmation AND its reception notice)", async () => {
    const clock = new FakeClock(NOW);
    const messaging = new FakeMessaging();
    const A = PATIENT;
    const B = "+55other";
    const row = (
      kind: "escalation" | "booking_confirmation",
      to: string,
      conv: string,
      body: string,
    ) => enqueueOutbox(pool, { kind, toPhone: to, conversationPhone: conv, body, now: NOW });
    await row("escalation", RECEPTION, B, "sobre B");
    await row("booking_confirmation", B, B, "para B");
    await row("escalation", RECEPTION, A, "sobre A");
    await row("booking_confirmation", A, A, "para A");

    const r = await dispatchOutbox(makeDeps(clock, messaging), { conversationPhone: A });

    expect(r.sent).toBe(2);
    expect(messaging.sent.map((m) => m.body).sort()).toEqual(["para A", "sobre A"]);
    const pending = (await rows()).filter((x) => x.status === "pending");
    expect(pending.map((x) => x.body).sort()).toEqual(["para B", "sobre B"]);
  });

  it("cancelPendingForRecipient cancels only that recipient's pending rows; the dispatcher skips them", async () => {
    const clock = new FakeClock(NOW);
    const messaging = new FakeMessaging();
    await enqueueOutbox(pool, {
      kind: "booking_confirmation",
      toPhone: PATIENT,
      body: "a",
      now: NOW,
    });
    await enqueueOutbox(pool, { kind: "escalation", toPhone: RECEPTION, body: "r", now: NOW });
    await enqueueOutbox(pool, {
      kind: "booking_confirmation",
      toPhone: PATIENT,
      body: "b",
      now: NOW,
    });

    const cancelled = await cancelPendingForRecipient(pool, PATIENT);
    expect(cancelled).toHaveLength(2);

    const r = await dispatchOutbox(makeDeps(clock, messaging));
    expect(r.sent).toBe(1);
    expect(messaging.sent).toEqual([{ to: RECEPTION, body: "r" }]);
    const all = await rows();
    expect(all.filter((x) => x.status === "cancelled")).toHaveLength(2);
    expect(
      all.filter((x) => x.status === "cancelled").every((x) => x.last_error?.includes("opt_out")),
    ).toBe(true);
  });

  it("a SLOW failed send schedules the retry from the failure time, not from the claim [Codex P2]", async () => {
    const clock = new FakeClock(NOW);
    const SEND_TOOK_MS = 20_000; // longer than the first backoff (5 s)
    const slowFailing = {
      async sendMessage() {
        clock.advance(SEND_TOOK_MS); // the provider hung, then failed
        throw new Error("provider timeout");
      },
    };
    await enqueueOutbox(pool, { kind: "escalation", toPhone: RECEPTION, body: "x", now: NOW });
    const deps: Deps = { ...makeDeps(clock, new FakeMessaging()), messaging: slowFailing };

    const r = await dispatchOutbox(deps, { batchSize: 5 });

    expect(r).toEqual({ sent: 0, retried: 1, failed: 0 }); // claimed ONCE in the batch, not re-claimed
    const [row] = await rows();
    expect(row.attempts).toBe(1);
    expect(new Date(row.next_attempt_at).getTime()).toBe(
      NOW.getTime() + SEND_TOOK_MS + OUTBOX_BACKOFF_MS[0],
    );
  });

  it("times out a hanging send and schedules a retry instead of blocking forever", async () => {
    const clock = new FakeClock(NOW);
    const hanging = {
      sendMessage: () => new Promise<void>(() => {}), // never settles
    };
    await enqueueOutbox(pool, { kind: "escalation", toPhone: RECEPTION, body: "x", now: NOW });
    const deps: Deps = { ...makeDeps(clock, new FakeMessaging()), messaging: hanging };
    const r = await dispatchOutbox(deps, { batchSize: 1, sendTimeoutMs: 50 });
    expect(r).toEqual({ sent: 0, retried: 1, failed: 0 });
    const [row] = await rows();
    expect(row.last_error).toMatch(/timeout/i);
  });
});

describe("outbox — trace context links delivery to the turn that committed it (005 FR-504)", () => {
  let tel: TestTelemetry;
  beforeAll(() => {
    tel = startTestTelemetry();
  });
  afterAll(async () => {
    await tel.stop();
  });
  beforeEach(() => tel.reset());

  async function enqueueIn(span: boolean): Promise<string> {
    const enqueue = async () => {
      const client = await pool.connect();
      try {
        return (await enqueueOutbox(client, {
          kind: "booking_confirmation",
          toPhone: PATIENT,
          conversationPhone: PATIENT,
          body: "ok",
          now: NOW,
        })) as string;
      } finally {
        client.release();
      }
    };
    return span ? withSpan("turn-origin", {}, enqueue) : enqueue();
  }

  it("stores the active traceparent on enqueue (NULL outside a span)", async () => {
    const inside = await enqueueIn(true);
    const outside = await enqueueIn(false);
    const r = await pool.query(
      "SELECT id, trace_context FROM outbox_message ORDER BY created_at, id",
    );
    const byId = new Map(r.rows.map((x) => [x.id, x.trace_context]));
    const [origin] = tel.byName("turn-origin");
    expect(byId.get(inside)).toBe(
      `00-${origin.spanContext().traceId}-${origin.spanContext().spanId}-01`,
    );
    expect(byId.get(outside)).toBeNull();
  });

  it("dispatch creates one outbox.dispatch span per row, linked to the enqueuing span, on send, retry and dead-letter", async () => {
    await enqueueIn(true);
    const messaging = new FakeMessaging();
    messaging.failTimes = 1;
    const clock = new FakeClock(NOW);
    await dispatchOutbox(makeDeps(clock, messaging)); // attempt 1 → retry
    clock.advance(OUTBOX_BACKOFF_MS[0]);
    await dispatchOutbox(makeDeps(clock, messaging)); // attempt 2 → sent
    const [origin] = tel.byName("turn-origin");
    const dispatches = tel.byName("outbox.dispatch");
    expect(dispatches.map((d) => d.attributes["recepia.outbox.result"])).toEqual([
      "retried",
      "sent",
    ]);
    for (const d of dispatches) {
      expect(d.links[0]?.context.spanId).toBe(origin.spanContext().spanId);
      expect(d.attributes["recepia.outbox.kind"]).toBe("booking_confirmation");
      expect(JSON.stringify(d.attributes)).not.toContain(PATIENT);
    }
    expect(dispatches.map((d) => d.attributes["recepia.outbox.attempt"])).toEqual([1, 2]);
  });

  it("a row without trace context is dispatched with no link and no error", async () => {
    await enqueueIn(false);
    await dispatchOutbox(makeDeps(new FakeClock(NOW), new FakeMessaging()));
    const [d] = tel.byName("outbox.dispatch");
    expect(d.links).toHaveLength(0);
    expect(d.attributes["recepia.outbox.result"]).toBe("sent");
  });
});

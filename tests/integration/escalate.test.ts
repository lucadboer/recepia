import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeCalendar } from "../../src/adapters/fakes/fake-calendar";
import { FakeClock } from "../../src/adapters/fakes/fake-clock";
import { FakeMessaging } from "../../src/adapters/fakes/fake-messaging";
import type { Pool } from "../../src/db/pool";
import type { Deps } from "../../src/deps";
import { dispatchOutbox } from "../../src/jobs/dispatch-outbox";
import { escalateToHuman } from "../../src/tools/escalate-to-human";
import { countAudit, ensureSchema, resetDb, testPool } from "../helpers/db";

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

function makeDeps(messaging: FakeMessaging): Deps {
  return {
    pool,
    clock: new FakeClock(new Date("2026-06-15T12:00:00Z")),
    calendar: new FakeCalendar(),
    messaging,
    receptionPhone: RECEPTION,
  };
}

interface OutboxRow {
  id: string;
  kind: string;
  to_phone: string;
  body: string;
  status: string;
}
async function outboxRows(): Promise<OutboxRow[]> {
  const r = await pool.query("SELECT * FROM outbox_message ORDER BY created_at");
  return r.rows as OutboxRow[];
}

describe("escalate_to_human", () => {
  it("enqueues the reception notice in the SAME transaction as the audit row; nothing is sent directly (T243, FR-214)", async () => {
    const messaging = new FakeMessaging();
    const d = makeDeps(messaging);
    await escalateToHuman(d, {
      reason: "non_routine",
      phone: PATIENT,
      context: "Paciente pediu Invisalign",
    });

    expect(messaging.sent).toHaveLength(0); // no direct send
    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("escalation");
    expect(rows[0].to_phone).toBe(RECEPTION);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].body).toContain("recepção");

    const audit = await pool.query("SELECT payload FROM audit_log WHERE action = 'escalated'");
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].payload.outboxId).toBe(rows[0].id);

    const { rows: b } = await pool.query("SELECT count(*)::int AS n FROM booking");
    expect(b[0].n).toBe(0);

    await dispatchOutbox(d);
    expect(messaging.sent).toEqual([{ to: RECEPTION, body: rows[0].body }]);
  });

  it("is atomic: if the outbox insert fails, no escalated audit row is written and the call rejects", async () => {
    const messaging = new FakeMessaging();
    const sentinel = new Error("outbox insert boom");
    const d: Deps = { ...makeDeps(messaging), pool: poolFailingOutboxInsert(pool, sentinel) };

    await expect(
      escalateToHuman(d, { reason: "urgency", phone: PATIENT, context: "dor" }),
    ).rejects.toBe(sentinel);

    expect(await countAudit(pool, "escalated")).toBe(0);
    expect(await outboxRows()).toHaveLength(0);
    expect(messaging.sent).toHaveLength(0);
  });

  it("audits reason, context, phone and summary in the payload", async () => {
    const messaging = new FakeMessaging();
    await escalateToHuman(makeDeps(messaging), {
      reason: "non_routine",
      phone: PATIENT,
      context: "Paciente pediu Invisalign",
      summary: ["Paciente: quero invisalign", "Assistente: vou encaminhar"],
    });

    const { rows } = await pool.query("SELECT payload FROM audit_log WHERE action = 'escalated'");
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.reason).toBe("non_routine");
    expect(rows[0].payload.context).toBe("Paciente pediu Invisalign");
    expect(rows[0].payload.phone).toBe(PATIENT);
    expect(rows[0].payload.summary).toEqual([
      "Paciente: quero invisalign",
      "Assistente: vou encaminhar",
    ]);
  });

  it("the reception message carries the patient phone, reason, context and each summary line (FR-204)", async () => {
    const messaging = new FakeMessaging();
    await escalateToHuman(makeDeps(messaging), {
      reason: "urgency",
      phone: PATIENT,
      context: "estou com muita dor",
      summary: [
        "Paciente: oi",
        "Assistente: olá! como posso ajudar?",
        "Paciente: estou com muita dor",
      ],
    });

    await dispatchOutbox(makeDeps(messaging));
    const body = messaging.sent[0].body;
    expect(body).toContain(`Paciente: ${PATIENT}`);
    expect(body).toContain("Motivo: urgency");
    expect(body).toContain("Contexto: estou com muita dor");
    expect(body).toContain("Últimas mensagens:");
    expect(body).toContain("- Paciente: oi");
    expect(body).toContain("- Assistente: olá! como posso ajudar?");
    expect(body).toContain("- Paciente: estou com muita dor");
  });

  it("omits the phone and summary sections for a patient-less system escalation", async () => {
    const messaging = new FakeMessaging();
    await escalateToHuman(makeDeps(messaging), {
      reason: "no_availability",
      phone: null,
      context: "Sem horários disponíveis para cleaning no horizonte de agendamento.",
    });

    await dispatchOutbox(makeDeps(messaging));
    const body = messaging.sent[0].body;
    expect(body).not.toContain("Paciente:");
    expect(body).not.toContain("Últimas mensagens");
    expect(body).toContain("Motivo: no_availability");
    const { rows } = await pool.query("SELECT payload FROM audit_log WHERE action = 'escalated'");
    expect(rows[0].payload.phone).toBeNull();
    expect(rows[0].payload.summary).toEqual([]);
  });
});

type AnyQuery = (...a: unknown[]) => unknown;

/** Rejects the outbox INSERT on clients checked out through the wrapper; restores on release. */
function poolFailingOutboxInsert(real: Pool, sentinel: Error): Pool {
  return {
    query: (...args: unknown[]) => (real as unknown as { query: AnyQuery }).query(...args),
    async connect() {
      const client = await real.connect();
      const mutable = client as unknown as { query: AnyQuery; release: AnyQuery };
      const origQuery = mutable.query.bind(client);
      const origRelease = mutable.release.bind(client);
      mutable.query = (...args: unknown[]) => {
        const sql =
          typeof args[0] === "string" ? args[0] : ((args[0] as { text?: string })?.text ?? "");
        if (sql.includes("INSERT INTO outbox_message")) return Promise.reject(sentinel);
        return origQuery(...args);
      };
      mutable.release = (...args: unknown[]) => {
        mutable.query = origQuery;
        mutable.release = origRelease;
        return origRelease(...args);
      };
      return client;
    },
  } as unknown as Pool;
}

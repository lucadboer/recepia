import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeCalendar } from "../../src/adapters/fakes/fake-calendar";
import { FakeClock } from "../../src/adapters/fakes/fake-clock";
import { FakeMessaging } from "../../src/adapters/fakes/fake-messaging";
import type { Pool } from "../../src/db/pool";
import type { Deps } from "../../src/deps";
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

describe("escalate_to_human", () => {
  it("notifies reception, creates no booking, and writes an audit row", async () => {
    const messaging = new FakeMessaging();
    await escalateToHuman(makeDeps(messaging), {
      reason: "non_routine",
      phone: PATIENT,
      context: "Paciente pediu Invisalign",
    });

    expect(messaging.sent).toHaveLength(1);
    expect(messaging.sent[0].to).toBe(RECEPTION);
    expect(messaging.sent[0].body).toContain("recepção");

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM booking");
    expect(rows[0].n).toBe(0);
    expect(await countAudit(pool, "escalated")).toBe(1);
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

    const body = messaging.sent[0].body;
    expect(body).not.toContain("Paciente:");
    expect(body).not.toContain("Últimas mensagens");
    expect(body).toContain("Motivo: no_availability");
    const { rows } = await pool.query("SELECT payload FROM audit_log WHERE action = 'escalated'");
    expect(rows[0].payload.phone).toBeNull();
    expect(rows[0].payload.summary).toEqual([]);
  });
});

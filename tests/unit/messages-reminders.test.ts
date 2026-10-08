import { describe, expect, it } from "vitest";
import {
  attendanceConfirmedMessagePt,
  reminderMessagePt,
  reminderTemplateParams,
  unconfirmedNoticePt,
} from "../../src/messages";

// T705 (007) — the reminder and its follow-ups: pt-BR, clinic-local time, never marketing.

const START = new Date("2026-06-18T12:00:00Z"); // qui 18/06/2026 09:00 local

describe("reminder", () => {
  it("names the patient, the type and the local day/time, and asks for a confirmation", () => {
    const m = reminderMessagePt({ name: "Ana Teste", type: "cleaning", start: START });
    expect(m).toContain("Ana");
    expect(m).toContain("limpeza");
    expect(m).toContain("18/06/2026 às 09:00");
    expect(m).toMatch(/SIM/);
    expect(m).toMatch(/remarcar|cancelar/);
  });

  it("works without a name", () => {
    const m = reminderMessagePt({ name: null, type: "evaluation", start: START });
    expect(m).toContain("avaliação");
    expect(m).not.toContain("null");
  });

  it("template params are [first name, type, date and time] with no line breaks", () => {
    const p = reminderTemplateParams({ name: "Ana\nTeste", type: "cleaning", start: START });
    expect(p).toEqual(["Ana", "limpeza", "18/06/2026 às 09:00"]);
    for (const x of p) expect(x).not.toMatch(/[\n\t]/);
    expect(reminderTemplateParams({ name: null, type: "cleaning", start: START })[0]).toBe(
      "paciente",
    );
  });
});

describe("follow-ups", () => {
  it("attendance reply restates the day and time", () => {
    const m = attendanceConfirmedMessagePt("cleaning", START);
    expect(m).toMatch(/confirmada/);
    expect(m).toContain("18/06/2026 às 09:00");
  });

  it("reception's unconfirmed notice names the patient, the phone and the time", () => {
    const m = unconfirmedNoticePt({
      name: "Ana Teste",
      phone: "+5531900000701",
      type: "cleaning",
      start: START,
    });
    expect(m).toMatch(/não confirmou/);
    expect(m).toContain("Ana Teste");
    expect(m).toContain("+5531900000701");
    expect(m).toContain("18/06/2026 às 09:00");
  });
});

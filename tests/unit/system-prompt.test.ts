import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../../src/agent/system-prompt";
import { TOOL_NAMES } from "../../src/agent/tool-schemas";
import { CLINIC_TIMEZONE } from "../../src/config";

const MONDAY = new Date("2026-06-15T12:00:00Z"); // Monday 09:00 in São Paulo
const WEDNESDAY = new Date("2026-06-17T19:30:00Z"); // Wednesday 16:30 in São Paulo

describe("buildSystemPrompt — dated, timezone-aware (FR-213)", () => {
  it("tells the model today's weekday, date, time, timezone and ISO offset", () => {
    const prompt = buildSystemPrompt({ now: MONDAY, timezone: CLINIC_TIMEZONE }).text;
    expect(prompt).toContain("Today is Monday, 2026-06-15"); // ISO date: no day/month ambiguity
    expect(prompt).toContain("09:00");
    expect(prompt).toContain("America/Sao_Paulo");
    expect(prompt).toContain("-03:00");
  });

  it("changes only the dated line between two instants (static block stays identical)", () => {
    const a = buildSystemPrompt({ now: MONDAY, timezone: CLINIC_TIMEZONE }).text.split("\n");
    const b = buildSystemPrompt({ now: WEDNESDAY, timezone: CLINIC_TIMEZONE }).text.split("\n");
    expect(a.length).toBe(b.length);
    expect(a.slice(0, -1)).toEqual(b.slice(0, -1)); // cache-friendly: static part first
    expect(a.at(-1)).not.toEqual(b.at(-1));
    expect(b.at(-1)).toContain("Wednesday, 2026-06-17");
    expect(b.at(-1)).toContain("16:30");
  });

  it("lists exactly the allowlisted tools", () => {
    const prompt = buildSystemPrompt({ now: MONDAY, timezone: CLINIC_TIMEZONE }).text;
    for (const name of Object.values(TOOL_NAMES)) expect(prompt).toContain(name);
  });
});

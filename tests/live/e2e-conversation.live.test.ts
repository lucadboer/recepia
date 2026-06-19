import { describe, expect, it } from "vitest";
import { handleInbound } from "../../src/agent/orchestrator";
import { buildAgentDeps, closeAgentDeps } from "../../src/composition";
import { ensureSchema, resetDb, seedRule } from "../helpers/db";

// LIVE end-to-end smoke — drives a real booking conversation through handleInbound
// with REAL adapters (Anthropic + Google Calendar + Evolution WhatsApp). Out of the
// default `pnpm test`. Run with:
//   LIVE_E2E=1 pnpm test:live
// Requires in .env: ANTHROPIC_*, GOOGLE_CALENDAR_*, EVOLUTION_* (BASE_URL/INSTANCE/API_KEY),
// RECEPTION_PHONE, DATABASE_URL, and LIVE_E2E_PATIENT_PHONE (a real test WhatsApp number,
// E.164 like +5531999998888) that will actually RECEIVE the agent's replies.
//
// WARNING: this resets the LOCAL dev database (resetDb truncates all tables) and seeds
// capacity. Run only against your dev Postgres. The real LLM is non-deterministic, so
// assertions are intentionally loose (smoke): the loop must not throw and must return a
// valid status; if a booking is confirmed it must carry a Calendar event id. Cleanup
// always deletes any created Calendar events and DB rows.
const live = process.env.LIVE_E2E === "1";

describe.skipIf(!live)("e2e conversation — LIVE (real LLM + Calendar + Evolution)", () => {
  it("drives a booking conversation end to end and cleans up", async () => {
    const deps = buildAgentDeps();
    const phone = process.env.LIVE_E2E_PATIENT_PHONE;
    if (!phone) throw new Error("LIVE_E2E_PATIENT_PHONE not set (NEEDS-USER)");

    try {
      // Seed capacity so get_availability returns slots (all weekdays 08:00–20:00, cap 2).
      await ensureSchema(deps.pool);
      await resetDb(deps.pool);
      for (let weekday = 0; weekday < 7; weekday++) {
        await seedRule(deps.pool, {
          weekday,
          startTime: "08:00",
          endTime: "20:00",
          capacity: 2,
        });
      }

      // A natural routine-booking flow: ask → choose → confirm (hits the consent
      // gate) → opt-in (SIM) → the next turn re-confirms now that consent exists.
      const messages = [
        "Oi! Gostaria de agendar uma limpeza, por favor.",
        "Pode ser o primeiro horário que você ofereceu.",
        "Sim, pode confirmar esse horário.",
        "SIM, autorizo o uso dos meus dados (nome e telefone) para o agendamento.",
      ];
      let i = 0;
      for (const text of messages) {
        const res = await handleInbound(deps, {
          phone,
          text,
          providerMessageId: `e2e-${Date.now()}-${i++}`,
        });
        expect(["replied", "escalated", "noop", "max_iterations"]).toContain(res.status);
      }

      // Best-effort: a confirmed booking must carry a real Calendar event id.
      const { rows } = await deps.pool.query(
        "SELECT id, google_event_id FROM booking WHERE patient_phone = $1 AND status = 'confirmed'",
        [phone],
      );
      if (rows.length > 0) {
        expect(rows[0].google_event_id).toBeTruthy();
      }
    } finally {
      // Cleanup: remove any Calendar events we created, then reset DB rows.
      const { rows } = await deps.pool.query("SELECT id FROM booking WHERE patient_phone = $1", [
        phone,
      ]);
      for (const row of rows) {
        await deps.calendar.deleteEvent(row.id).catch(() => {});
      }
      await resetDb(deps.pool).catch(() => {});
      await closeAgentDeps(deps);
    }
  }, 120_000);
});

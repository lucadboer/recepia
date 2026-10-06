import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeLLM } from "../../src/adapters/fakes/fake-llm";
import { handleInbound } from "../../src/agent/orchestrator";
import type { InboundMessage } from "../../src/agent/types";
import type { Pool } from "../../src/db/pool";
import { makeAgent, RECEPTION } from "../helpers/agent";
import { countAudit, ensureSchema, resetDb, testPool } from "../helpers/db";

const PHONE = "+55pac";

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

function inbound(text: string): InboundMessage {
  return { phone: PHONE, text, providerMessageId: `t-${text.length}-${text.slice(0, 3)}` };
}

describe("orchestrator — triage escalates every category BEFORE the LLM", () => {
  it.each([
    ["estou com muita dor", "urgency"],
    ["quero colocar um implante", "specialized_procedure"],
    ["quero continuar o tratamento", "ongoing_treatment"],
    ["quero falar com a doutora", "specific_professional"],
    ["quero fazer uma reclamação", "complaint"],
    ["qual o valor da limpeza", "financial"],
    ["quero falar com um humano", "human_requested"],
  ])("escalates %j without calling the LLM and writes no booking", async (text) => {
    const llm = new FakeLLM([]); // throws if called
    const h = makeAgent(pool, llm);

    const r = await handleInbound(h.deps, inbound(text));

    expect(r.status).toBe("escalated");
    expect(llm.callCount).toBe(0); // pre-LLM backstop
    expect(await countAudit(pool, "escalated")).toBe(1);
    const toReception = h.messaging.sent.filter((m) => m.to === RECEPTION);
    expect(toReception).toHaveLength(1);
    // Reception must be able to call the patient back: phone + what they said (FR-204).
    expect(toReception[0].body).toContain(`Paciente: ${PHONE}`);
    expect(toReception[0].body).toContain(`Contexto: ${text}`);
    // First message of the conversation: nothing BEFORE the trigger to excerpt, and the
    // trigger itself is not repeated as a summary line.
    expect(toReception[0].body).not.toContain("Últimas mensagens");
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM booking");
    expect(rows[0].n).toBe(0);
  });
});

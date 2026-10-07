import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeLLM, finalTurn, toolUse, toolUseTurn } from "../../src/adapters/fakes/fake-llm";
import { recordConsent } from "../../src/agent/consent";
import { handleInbound } from "../../src/agent/orchestrator";
import { TOOL_NAMES } from "../../src/agent/tool-schemas";
import type { Pool } from "../../src/db/pool";
import { ConversationConflictError } from "../../src/domain/errors";
import { configureLogger, log } from "../../src/telemetry/logger";
import { createWebhookServer } from "../../src/webhook/server";
import { AGENT_NOW, DAY_END, lastHoldId, makeAgent } from "../helpers/agent";
import { ensureSchema, resetDb, seedRule, testPool } from "../helpers/db";
import { startTestTelemetry, type TestTelemetry, telemetryStrings } from "../helpers/telemetry";

// T522 / SC-502 — run real conversations with debug logs captured and an in-memory exporter and
// prove that no full phone number and no message text reaches either.

const SECRET = "s3cr3t-token";
const PHONE = "+5531900000155";
const DIGITS = "5531900000155";
const JID = `${DIGITS}@s.whatsapp.net`;
const TEXTS = {
  booking: "quero marcar uma limpeza hoje de manhã",
  pain: "estou com muita dor no siso",
  name: "Iara Teste",
  reply: "Confirmado, até logo!",
};

let pool: Pool;
let tel: TestTelemetry;
let lines: string[] = [];

beforeAll(async () => {
  pool = testPool();
  await ensureSchema(pool);
  tel = startTestTelemetry();
  configureLogger({
    level: "debug",
    destination: new Writable({
      write(chunk, _e, cb) {
        lines.push(chunk.toString());
        cb();
      },
    }),
  });
});
afterAll(async () => {
  configureLogger({ level: "silent" });
  await tel.stop();
  await pool.end();
});
beforeEach(async () => {
  await resetDb(pool);
  await seedRule(pool, { weekday: 1, startTime: "09:00", endTime: "18:00", capacity: 2 });
  tel.reset();
  lines = [];
});

function assertClean(): void {
  const haystack = [...lines, ...telemetryStrings(tel.spans())];
  expect(haystack.length).toBeGreaterThan(0);
  for (const s of haystack) {
    expect(s).not.toContain(DIGITS);
    for (const t of Object.values(TEXTS)) expect(s).not.toContain(t);
  }
}

async function postAndWait(base: string, id: string, text: string): Promise<void> {
  const before = tel.byName("webhook.inbound").length;
  const res = await fetch(`${base}/webhook/evolution/${SECRET}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: SECRET },
    body: JSON.stringify({
      event: "messages.upsert",
      data: { key: { remoteJid: JID, fromMe: false, id }, message: { conversation: text } },
    }),
  });
  expect(res.status).toBe(200);
  for (let i = 0; i < 200 && tel.byName("webhook.inbound").length <= before; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("SC-502 — no personal data in logs or traces", () => {
  let server: Server | null = null;
  afterAll(() => server?.close());

  it("a booking and an urgent message through the webhook leave only pseudonyms behind", async () => {
    const llm = new FakeLLM([
      toolUseTurn(
        toolUse(TOOL_NAMES.availability, {
          from: AGENT_NOW.toISOString(),
          to: DAY_END,
          type: "cleaning",
        }),
      ),
      toolUseTurn(
        toolUse(TOOL_NAMES.hold, { start: "2026-06-15T14:00:00.000Z", type: "cleaning" }),
      ),
      (i) =>
        toolUseTurn(
          toolUse(TOOL_NAMES.confirm, {
            hold_id: lastHoldId(i.messages),
            patient_name: TEXTS.name,
          }),
        ),
      finalTurn(TEXTS.reply),
    ]);
    const h = makeAgent(pool, llm);
    await recordConsent(h.deps, PHONE);
    server = createWebhookServer({ secret: SECRET, onInbound: (m) => handleInbound(h.deps, m) });
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await postAndWait(base, "PII-1", TEXTS.booking);
    await postAndWait(base, "PII-2", TEXTS.pain);

    const parsed = lines.flatMap((l) => l.split("\n").filter(Boolean)).map((l) => JSON.parse(l));
    const inbound = parsed.filter((l) => l.event === "webhook.inbound");
    expect(inbound).toHaveLength(2);
    expect(inbound[0].patient).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{16}$/),
      phoneMasked: "***0155",
    });
    expect(parsed.filter((l) => l.event === "turn.done").map((l) => l.status)).toEqual([
      "replied",
      "escalated",
    ]);
    assertClean();
  });

  it("review fixes H3/H4 — a wamid id, a provider error echoing the phone + text, and trace ids on webhook logs", async () => {
    // Meta's documented sample wamid: base64 of a payload with the sender's number in it.
    const WAMID = "wamid.HBgLMTY1MDUwNzY1MjAVAgARGBI5QTNDQTVCM0Q0Q0Q2RTY3RTcA";
    const h = makeAgent(pool, new FakeLLM([]));
    // A provider whose error body echoes the recipient and the text it was asked to send.
    h.deps.messaging = {
      async sendMessage(to: string, body: string) {
        throw new Error(`HTTP 400 recipient ${to.replace("+", "")} rejected text "${body}"`);
      },
    };
    const srv = createWebhookServer({ secret: SECRET, onInbound: (m) => handleInbound(h.deps, m) });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    try {
      const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
      await postAndWait(base, WAMID, TEXTS.pain); // triage → escalation → patient reply send fails
    } finally {
      srv.close();
    }
    const haystack = [...lines, ...telemetryStrings(tel.spans())];
    for (const s of haystack) {
      expect(s).not.toContain(WAMID);
      expect(s).not.toContain("HBgLMTY1MDUwNzY1MjA"); // the phone-carrying part of the id
      expect(s).not.toContain(DIGITS);
      expect(s).not.toContain(TEXTS.pain);
    }
    // The failure is still diagnosable: masked message in the log, error type on the span.
    const parsed = lines.flatMap((l) => l.split("\n").filter(Boolean)).map((l) => JSON.parse(l));
    const failed = parsed.find((l) => l.event === "webhook.inbound_failed");
    expect(failed?.err?.message).toMatch(/HTTP 400 recipient \*\*\*0155/);
    const [inbound] = tel.byName("webhook.inbound");
    expect(inbound.status.code).toBe(2);
    expect(inbound.attributes["error.type"]).toBe("Error");
    // Webhook log lines carry the inbound span's trace id (Codex review).
    const accepted = parsed.find((l) => l.event === "webhook.inbound");
    expect(accepted?.trace_id).toBe(inbound.spanContext().traceId);
    expect(failed?.trace_id).toBe(inbound.spanContext().traceId);
  });

  it("errors that embed a phone and a hostile tool name carrying one are masked too", async () => {
    log.error(
      { event: "x", err: new ConversationConflictError(PHONE, 3) },
      `save lost for ${PHONE}`,
    );
    const llm = new FakeLLM([
      toolUseTurn(toolUse(`call_${DIGITS}`, { phone: PHONE })),
      finalTurn("ok"),
    ]);
    const h = makeAgent(pool, llm);
    await handleInbound(h.deps, { phone: PHONE, text: TEXTS.booking, providerMessageId: "PII-3" });
    assertClean();
    expect(tel.spans().some((s) => s.name.startsWith("execute_tool call_***0155"))).toBe(true);
  });
});

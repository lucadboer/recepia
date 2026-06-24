import crypto from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { CloudStatus } from "../../src/adapters/messaging/inbound/cloud-api-parser";
import type { InboundMessage } from "../../src/agent/types";
import { createWebhookServer, type WebhookServerOptions } from "../../src/webhook/server";

const VT = "verify-token-xyz";
const APP_SECRET = "app-secret-123";
const EVO_SECRET = "evo-secret";
const CLOUD = "/webhook/cloud";
const EVO = "/webhook/evolution";

const sign = (body: string) =>
  `sha256=${crypto.createHmac("sha256", APP_SECRET).update(body).digest("hex")}`;

const cloudInbound = (id: string) =>
  JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "PNID" },
              contacts: [{ wa_id: "5516981526867" }],
              messages: [
                {
                  from: "5516981526867",
                  id,
                  type: "text",
                  text: { body: "oi" },
                  timestamp: "1700000000",
                },
              ],
            },
          },
        ],
      },
    ],
  });

const cloudStatus = (id: string) =>
  JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "PNID" },
              statuses: [
                {
                  id,
                  status: "failed",
                  recipient_id: "5516981526867",
                  errors: [{ code: 131031, title: "locked" }],
                },
              ],
            },
          },
        ],
      },
    ],
  });

const evoUpsert = (id: string) =>
  JSON.stringify({
    event: "messages.upsert",
    data: {
      key: { remoteJid: "5531999998888@s.whatsapp.net", fromMe: false, id },
      message: { conversation: "oi" },
    },
  });

const settle = () => new Promise((r) => setTimeout(r, 30));

function start(
  extra: Partial<WebhookServerOptions>,
  captured: { inbound: InboundMessage[]; statuses: CloudStatus[] },
) {
  return new Promise<{ server: Server; port: number }>((resolve) => {
    const server = createWebhookServer({
      secret: EVO_SECRET,
      onInbound: async () => {}, // evolution sink (unused unless evolution path hit)
      cloud: {
        verifyToken: VT,
        appSecret: APP_SECRET,
        onInbound: async (m) => {
          captured.inbound.push(m);
        },
        onStatus: (s) => {
          captured.statuses.push(s);
        },
      },
      ...extra,
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: (server.address() as AddressInfo).port }),
    );
  });
}

describe("webhook server — Cloud API path", () => {
  let server: Server | null = null;
  afterEach(() => {
    server?.close();
    server = null;
  });

  it("GET verify echoes the challenge with the correct verify token", async () => {
    const cap = { inbound: [] as InboundMessage[], statuses: [] as CloudStatus[] };
    const s = await start({}, cap);
    server = s.server;
    const res = await fetch(
      `http://127.0.0.1:${s.port}${CLOUD}?hub.mode=subscribe&hub.verify_token=${VT}&hub.challenge=CHAL123`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("CHAL123");
  });

  it("GET verify returns 403 for a wrong verify token", async () => {
    const cap = { inbound: [] as InboundMessage[], statuses: [] as CloudStatus[] };
    const s = await start({}, cap);
    server = s.server;
    const res = await fetch(
      `http://127.0.0.1:${s.port}${CLOUD}?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=CHAL123`,
    );
    expect(res.status).toBe(403);
  });

  it("POST inbound (valid HMAC) → 200 + onInbound once, no statuses", async () => {
    const cap = { inbound: [] as InboundMessage[], statuses: [] as CloudStatus[] };
    const s = await start({}, cap);
    server = s.server;
    const body = cloudInbound("wamid.IN1");
    const res = await fetch(`http://127.0.0.1:${s.port}${CLOUD}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
      body,
    });
    expect(res.status).toBe(200);
    await settle();
    expect(cap.inbound).toHaveLength(1);
    expect(cap.inbound[0]).toMatchObject({
      phone: "+5516981526867",
      providerMessageId: "wamid.IN1",
    });
    expect(cap.statuses).toHaveLength(0);
  });

  it("POST status-only (valid HMAC) → 200, ZERO onInbound, status logged", async () => {
    const cap = { inbound: [] as InboundMessage[], statuses: [] as CloudStatus[] };
    const s = await start({}, cap);
    server = s.server;
    const body = cloudStatus("wamid.ST1");
    const res = await fetch(`http://127.0.0.1:${s.port}${CLOUD}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
      body,
    });
    expect(res.status).toBe(200);
    await settle();
    expect(cap.inbound).toHaveLength(0); // statuses NEVER reach onInbound
    expect(cap.statuses).toHaveLength(1);
    expect(cap.statuses[0]).toMatchObject({ id: "wamid.ST1", status: "failed" });
    expect(cap.statuses[0].errors?.[0]?.code).toBe(131031);
  });

  it("POST with a bad signature → 401, onInbound never called", async () => {
    const cap = { inbound: [] as InboundMessage[], statuses: [] as CloudStatus[] };
    const s = await start({}, cap);
    server = s.server;
    const body = cloudInbound("wamid.IN2");
    const res = await fetch(`http://127.0.0.1:${s.port}${CLOUD}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=bad" },
      body,
    });
    expect(res.status).toBe(401);
    await settle();
    expect(cap.inbound).toHaveLength(0);
  });

  it("coexists: the Evolution path still works with cloud configured", async () => {
    const cap = { inbound: [] as InboundMessage[], statuses: [] as CloudStatus[] };
    const evo: InboundMessage[] = [];
    const s = await start(
      {
        onInbound: async (m) => {
          evo.push(m);
        },
      },
      cap,
    );
    server = s.server;
    const res = await fetch(`http://127.0.0.1:${s.port}${EVO}/${EVO_SECRET}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: EVO_SECRET },
      body: evoUpsert("EVO-1"),
    });
    expect(res.status).toBe(200);
    await settle();
    expect(evo).toHaveLength(1);
    expect(evo[0].providerMessageId).toBe("EVO-1");
  });
});

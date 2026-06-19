import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { InboundMessage } from "../../src/agent/types";
import { createWebhookServer } from "../../src/webhook/server";

const SECRET = "s3cr3t-token";
const BASE = "/webhook/evolution";

const upsert = (id: string) =>
  JSON.stringify({
    event: "messages.upsert",
    data: {
      key: { remoteJid: "5531999998888@s.whatsapp.net", fromMe: false, id },
      message: { conversation: "oi" },
    },
  });

function start(onInbound: (m: InboundMessage) => Promise<unknown>) {
  return new Promise<{ server: Server; port: number }>((resolve) => {
    const server = createWebhookServer({ secret: SECRET, onInbound });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port });
    });
  });
}

const settle = () => new Promise((r) => setTimeout(r, 30)); // let background onInbound run

describe("webhook server (node:http)", () => {
  let server: Server | null = null;
  afterEach(() => {
    server?.close();
    server = null;
  });

  it("accepts a valid signed inbound (200) and calls onInbound exactly once", async () => {
    const seen: InboundMessage[] = [];
    const s = await start(async (m) => {
      seen.push(m);
    });
    server = s.server;
    const res = await fetch(`http://127.0.0.1:${s.port}${BASE}/${SECRET}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: SECRET },
      body: upsert("MSG-1"),
    });
    expect(res.status).toBe(200);
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      phone: "+5531999998888",
      text: "oi",
      providerMessageId: "MSG-1",
    });
  });

  it("rejects a wrong secret with 401 and never calls onInbound", async () => {
    let calls = 0;
    const s = await start(async () => {
      calls++;
    });
    server = s.server;
    const res = await fetch(`http://127.0.0.1:${s.port}${BASE}/WRONGTOKEN`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "WRONGTOKEN" },
      body: upsert("MSG-2"),
    });
    expect(res.status).toBe(401);
    await settle();
    expect(calls).toBe(0);
  });

  it("edge-dedupes a redelivered providerMessageId (onInbound once)", async () => {
    let calls = 0;
    const s = await start(async () => {
      calls++;
    });
    server = s.server;
    const url = `http://127.0.0.1:${s.port}${BASE}/${SECRET}`;
    const headers = { "content-type": "application/json", authorization: SECRET };
    await fetch(url, { method: "POST", headers, body: upsert("DUP-1") });
    await fetch(url, { method: "POST", headers, body: upsert("DUP-1") });
    await settle();
    expect(calls).toBe(1);
  });
});

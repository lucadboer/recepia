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

function startSrv(opts: Parameters<typeof createWebhookServer>[0]) {
  return new Promise<{ server: Server; port: number }>((resolve) => {
    const server = createWebhookServer(opts);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

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

  it("routes a background onInbound rejection to onError, still acking 200", async () => {
    const sentinel = new Error("boom");
    let captured: unknown = null;
    const s = await startSrv({
      secret: SECRET,
      onInbound: () => Promise.reject(sentinel),
      onError: (e) => {
        captured = e;
      },
    });
    server = s.server;
    const res = await fetch(`http://127.0.0.1:${s.port}${BASE}/${SECRET}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: SECRET },
      body: upsert("ERR-1"),
    });
    expect(res.status).toBe(200); // ack is independent of background processing
    await settle();
    expect(captured).toBe(sentinel);
  });

  it("serializes inbound processing PER PHONE but overlaps across phones [T240]", async () => {
    const upsertFrom = (jid: string, id: string) =>
      JSON.stringify({
        event: "messages.upsert",
        data: {
          key: { remoteJid: `${jid}@s.whatsapp.net`, fromMe: false, id },
          message: { conversation: "oi" },
        },
      });
    let active = 0;
    let maxActive = 0;
    const perPhoneMax = new Map<string, number>();
    const perPhoneActive = new Map<string, number>();
    const s = await startSrv({
      secret: SECRET,
      onInbound: async (m) => {
        active++;
        maxActive = Math.max(maxActive, active);
        const a = (perPhoneActive.get(m.phone) ?? 0) + 1;
        perPhoneActive.set(m.phone, a);
        perPhoneMax.set(m.phone, Math.max(perPhoneMax.get(m.phone) ?? 0, a));
        await new Promise((r) => setTimeout(r, 40));
        perPhoneActive.set(m.phone, a - 1);
        active--;
      },
    });
    server = s.server;
    const url = `http://127.0.0.1:${s.port}${BASE}/${SECRET}`;
    const headers = { "content-type": "application/json", authorization: SECRET };
    await Promise.all([
      fetch(url, { method: "POST", headers, body: upsertFrom("5531999990001", "P1-a") }),
      fetch(url, { method: "POST", headers, body: upsertFrom("5531999990001", "P1-b") }),
      fetch(url, { method: "POST", headers, body: upsertFrom("5531999990002", "P2-a") }),
    ]);
    await new Promise((r) => setTimeout(r, 200));
    expect(perPhoneMax.get("+5531999990001")).toBe(1); // same phone: never concurrent
    expect(maxActive).toBeGreaterThanOrEqual(2); // different phones: overlapped
  });

  it("returns 404 for a path that merely shares the prefix (/webhook/evolutionary) [T229]", async () => {
    let calls = 0;
    const s = await startSrv({
      secret: SECRET,
      onInbound: async () => {
        calls++;
      },
    });
    server = s.server;
    const res = await fetch(`http://127.0.0.1:${s.port}${BASE}ary/${SECRET}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: SECRET },
      body: upsert("PFX-1"),
    });
    expect(res.status).toBe(404); // not 401: this is not our route at all
    await settle();
    expect(calls).toBe(0);
  });

  it("returns 404 when the token is followed by extra path segments", async () => {
    let calls = 0;
    const s = await startSrv({
      secret: SECRET,
      onInbound: async () => {
        calls++;
      },
    });
    server = s.server;
    const res = await fetch(`http://127.0.0.1:${s.port}${BASE}/${SECRET}/extra`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: SECRET },
      body: upsert("SEG-1"),
    });
    expect(res.status).toBe(404);
    await settle();
    expect(calls).toBe(0);
  });

  it("rejects an oversized body with 413 and never calls onInbound [T246]", async () => {
    let calls = 0;
    const s = await startSrv({
      secret: SECRET,
      onInbound: async () => {
        calls++;
      },
    });
    server = s.server;
    const huge = JSON.stringify({
      event: "messages.upsert",
      data: {
        key: { remoteJid: "5531999998888@s.whatsapp.net", fromMe: false, id: "BIG-1" },
        message: { conversation: "x".repeat(300 * 1024) }, // > 256 KiB
      },
    });
    const res = await fetch(`http://127.0.0.1:${s.port}${BASE}/${SECRET}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: SECRET },
      body: huge,
    });
    expect(res.status).toBe(413);
    await settle();
    expect(calls).toBe(0);
  });

  it("re-processes a redelivery after a FAILED turn, and skips it only after a successful one [T230]", async () => {
    let calls = 0;
    const s = await startSrv({
      secret: SECRET,
      onInbound: async () => {
        calls++;
        if (calls === 1) throw new Error("transient");
      },
      onError: () => {},
    });
    server = s.server;
    const url = `http://127.0.0.1:${s.port}${BASE}/${SECRET}`;
    const headers = { "content-type": "application/json", authorization: SECRET };
    await fetch(url, { method: "POST", headers, body: upsert("RD-1") }); // fails
    await settle();
    expect(calls).toBe(1);
    await fetch(url, { method: "POST", headers, body: upsert("RD-1") }); // redelivery → processed again
    await settle();
    expect(calls).toBe(2);
    await fetch(url, { method: "POST", headers, body: upsert("RD-1") }); // now deduped at the edge
    await settle();
    expect(calls).toBe(2);
  });

  it("returns 404 for non-POST methods and never calls onInbound", async () => {
    let calls = 0;
    const s = await startSrv({
      secret: SECRET,
      onInbound: async () => {
        calls++;
      },
    });
    server = s.server;
    for (const method of ["GET", "PUT", "DELETE"]) {
      const res = await fetch(`http://127.0.0.1:${s.port}${BASE}/${SECRET}`, { method });
      expect(res.status).toBe(404);
    }
    await settle();
    expect(calls).toBe(0);
  });

  it("returns 404 for an unrelated path and never calls onInbound", async () => {
    let calls = 0;
    const s = await startSrv({
      secret: SECRET,
      onInbound: async () => {
        calls++;
      },
    });
    server = s.server;
    const res = await fetch(`http://127.0.0.1:${s.port}/nope`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: SECRET },
      body: upsert("X"),
    });
    expect(res.status).toBe(404);
    await settle();
    expect(calls).toBe(0);
  });
});

import type { Server } from "node:http";
import { type AddressInfo, connect } from "node:net";
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

function start(enqueue: (m: InboundMessage) => Promise<void>) {
  return new Promise<{ server: Server; port: number }>((resolve) => {
    const server = createWebhookServer({ secret: SECRET, enqueue });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port });
    });
  });
}

const settle = () => new Promise((r) => setTimeout(r, 30));

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

  it("accepts a valid signed inbound (200) and stores it exactly once", async () => {
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

  it("rejects a wrong secret with 401 and never stores it", async () => {
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

  it("acknowledges only after the message is stored (008: an ack is a promise)", async () => {
    let stored = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const s = await start(async () => {
      await gate;
      stored = true;
    });
    server = s.server;
    let answered = false;
    const res = fetch(`http://127.0.0.1:${s.port}${BASE}/${SECRET}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: SECRET },
      body: upsert("ACK-1"),
    }).then((r) => {
      answered = true;
      return r;
    });
    await settle();
    expect(answered).toBe(false); // still storing
    release();
    expect((await res).status).toBe(200);
    expect(stored).toBe(true);
  });

  it("answers a retryable 503 when the message cannot be stored, and reports it", async () => {
    const sentinel = new Error("db down");
    let captured: unknown = null;
    const s = await startSrv({
      secret: SECRET,
      enqueue: () => Promise.reject(sentinel),
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
    expect(res.status).toBe(503); // the provider retries; nothing was promised
    expect(res.headers.get("retry-after")).toBe("5");
    expect(captured).toBe(sentinel);
  });

  it("returns 404 for a path that merely shares the prefix (/webhook/evolutionary) [T229]", async () => {
    let calls = 0;
    const s = await startSrv({
      secret: SECRET,
      enqueue: async () => {
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
      enqueue: async () => {
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

  it("rejects an oversized body with 413 and never stores it [T246]", async () => {
    let calls = 0;
    const s = await startSrv({
      secret: SECRET,
      enqueue: async () => {
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

  it("answers 400 to a request target WHATWG URL cannot parse (e.g. '//') and stays alive", async () => {
    let calls = 0;
    const s = await startSrv({
      secret: SECRET,
      enqueue: async () => {
        calls++;
      },
    });
    server = s.server;
    const raw = await new Promise<string>((resolve, reject) => {
      const sock = connect(s.port, "127.0.0.1", () => {
        sock.write("GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
      });
      let data = "";
      sock.on("data", (c) => {
        data += c.toString();
      });
      sock.on("end", () => resolve(data));
      sock.on("error", reject);
    });
    expect(raw.startsWith("HTTP/1.1 400")).toBe(true);
    // Still serving: a valid request right after is accepted.
    const res = await fetch(`http://127.0.0.1:${s.port}${BASE}/${SECRET}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: SECRET },
      body: upsert("ALIVE-1"),
    });
    expect(res.status).toBe(200);
    await settle();
    expect(calls).toBe(1);
  });

  it("returns 404 for non-POST methods and never stores it", async () => {
    let calls = 0;
    const s = await startSrv({
      secret: SECRET,
      enqueue: async () => {
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

  it("returns 404 for an unrelated path and never stores it", async () => {
    let calls = 0;
    const s = await startSrv({
      secret: SECRET,
      enqueue: async () => {
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

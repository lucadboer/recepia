import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createWebhookServer, type WebhookServerOptions } from "../../src/webhook/server";

// T519 — liveness and readiness (FR-508): no auth, no configuration revealed, exact paths.

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

async function start(ready?: WebhookServerOptions["ready"]): Promise<string> {
  server = createWebhookServer({ secret: "s3cr3t", onInbound: async () => undefined, ready });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("health endpoints", () => {
  it("/healthz answers 200 without touching the readiness probe", async () => {
    let probed = 0;
    const base = await start(async () => {
      probed++;
      return false;
    });
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(probed).toBe(0);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
  });

  it("/readyz is 200 when the probe resolves true, 503 when false, throws or hangs past 1 s", async () => {
    expect((await fetch(`${await start(async () => true)}/readyz`)).status).toBe(200);
    server?.close();
    const notReady = await fetch(`${await start(async () => false)}/readyz`);
    expect(notReady.status).toBe(503);
    expect(await notReady.json()).toEqual({ status: "not_ready" });
    server?.close();
    expect(
      (
        await fetch(
          `${await start(async () => {
            throw new Error("ECONNREFUSED 10.0.0.1:5432");
          })}/readyz`,
        )
      ).status,
    ).toBe(503);
    server?.close();
    const t0 = Date.now();
    const hung = await fetch(`${await start(() => new Promise<boolean>(() => {}))}/readyz`);
    expect(hung.status).toBe(503);
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  it("/readyz without a probe answers 200 (nothing to check)", async () => {
    expect((await fetch(`${await start()}/readyz`)).status).toBe(200);
  });

  it("HEAD is allowed, other methods get 405, near-miss paths stay 404, bodies reveal nothing", async () => {
    const base = await start(async () => true);
    expect((await fetch(`${base}/healthz`, { method: "HEAD" })).status).toBe(200);
    expect((await fetch(`${base}/readyz`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/healthz/`)).status).toBe(404);
    expect((await fetch(`${base}/healthzz`)).status).toBe(404);
    const body = await (await fetch(`${base}/readyz`)).text();
    expect(body).not.toMatch(/s3cr3t|postgres|version/i);
  });
});

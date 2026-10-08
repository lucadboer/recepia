import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type AgentDeps, handleInbound } from "../../src/agent/orchestrator";
import type { InboundMessage } from "../../src/agent/types";
import type { Pool } from "../../src/db/pool";
import { createInboundWorker, type InboundWorker } from "../../src/jobs/inbound-worker";
import { createDurableEnqueue } from "../../src/webhook/enqueue";
import { createWebhookServer, type WebhookServerOptions } from "../../src/webhook/server";

/**
 * The production inbound path for tests (008): webhook → durable store → worker → orchestrator.
 * `handler` defaults to handleInbound with the given deps.
 */
export async function startPipeline(
  deps: AgentDeps,
  opts: {
    secret: string;
    handler?: (m: InboundMessage) => Promise<unknown>;
    server?: Partial<WebhookServerOptions>;
  },
): Promise<{ base: string; server: Server; worker: InboundWorker; stop(): Promise<void> }> {
  const worker = createInboundWorker({
    pool: deps.pool,
    clock: deps.clock,
    receptionPhone: deps.receptionPhone,
    pollMs: 10,
    handler: opts.handler ?? ((m) => handleInbound(deps, m)),
  });
  const server = createWebhookServer({
    secret: opts.secret,
    enqueue: createDurableEnqueue({
      pool: deps.pool,
      clock: deps.clock,
      onStored: () => worker.wake(),
    }),
    ...opts.server,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  worker.start();
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    server,
    worker,
    async stop() {
      await worker.drain(2_000);
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** Wait until the stored message left `pending`/`processing` at least once (done, dead or retried). */
export async function waitProcessed(
  pool: Pool,
  providerMessageId: string,
  ms = 5_000,
): Promise<string> {
  const deadline = Date.now() + ms;
  for (;;) {
    const { rows } = await pool.query(
      "SELECT status, attempts FROM inbound_message WHERE provider_message_id = $1",
      [providerMessageId],
    );
    const r = rows[0] as { status: string; attempts: number } | undefined;
    if (
      r &&
      (r.status === "done" || r.status === "dead" || (r.status === "pending" && r.attempts > 0))
    ) {
      return r.status;
    }
    if (Date.now() > deadline)
      throw new Error(`message ${providerMessageId} not processed in time`);
    await new Promise((res) => setTimeout(res, 10));
  }
}

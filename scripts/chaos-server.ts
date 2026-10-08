// Child process for scripts/inbound-chaos.ts (008): the production inbound path — webhook → durable
// store → worker → orchestrator — with fake calendar/WhatsApp and the scripted booking model.
// It prints `READY <port>` once listening; the parent kills it with SIGKILL at random moments.

import type { AddressInfo } from "node:net";
import { FakeCalendar } from "../src/adapters/fakes/fake-calendar";
import { FakeMessaging } from "../src/adapters/fakes/fake-messaging";
import { type AgentDeps, handleInbound } from "../src/agent/orchestrator";
import { loadEnv } from "../src/db/env";
import { makePool } from "../src/db/pool";
import { DbConversationStore } from "../src/db/repositories/conversation-repo";
import { createInboundWorker } from "../src/jobs/inbound-worker";
import { systemClock } from "../src/ports/clock";
import { createDurableEnqueue } from "../src/webhook/enqueue";
import { createWebhookServer } from "../src/webhook/server";
import { BookingScriptLLM } from "./perf-smoke";

loadEnv();
const secret = process.env.CHAOS_SECRET ?? "chaos-secret";
const port = Number(process.env.CHAOS_PORT ?? 0);
const pool = makePool();
const deps: AgentDeps = {
  pool,
  clock: systemClock,
  calendar: new FakeCalendar(),
  messaging: new FakeMessaging(),
  receptionPhone: "+5511999990000",
  llm: new BookingScriptLLM(),
  conversations: new DbConversationStore(pool),
};
const worker = createInboundWorker({
  pool,
  clock: systemClock,
  receptionPhone: deps.receptionPhone,
  pollMs: 25,
  // A short lease so the parent sees a killed worker's message reclaimed within the run.
  leaseMs: Number(process.env.CHAOS_LEASE_MS ?? 2_000),
  handler: (msg) => handleInbound(deps, msg),
});
const server = createWebhookServer({
  secret,
  enqueue: createDurableEnqueue({ pool, clock: systemClock, onStored: () => worker.wake() }),
});
server.listen(port, "127.0.0.1", () => {
  worker.start();
  process.stdout.write(`READY ${(server.address() as AddressInfo).port}\n`);
});

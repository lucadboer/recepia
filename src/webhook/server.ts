import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { CloudStatus } from "../adapters/messaging/inbound/cloud-api-parser";
import type { InboundMessage } from "../agent/types";
import { parseAndAcceptCloud, verifyChallenge } from "./cloud-dispatch";
import { parseAndAccept, RecentIds } from "./dispatch";
import { PerKeyQueue } from "./per-key-queue";

export interface CloudWebhookOptions {
  /** URL prefix for the Cloud API webhook. Default: "/webhook/cloud". */
  basePath?: string;
  /** Verify token (GET challenge), chosen by you and set in the Meta dashboard. */
  verifyToken: string;
  /** Meta App Secret, used to validate the X-Hub-Signature-256 HMAC. */
  appSecret: string;
  /** Inbound patient messages → orchestrator. */
  onInbound: (msg: InboundMessage) => Promise<unknown>;
  /** Delivery-status receipts → log/observe only (never the orchestrator). */
  onStatus?: (s: CloudStatus) => void;
  recent?: RecentIds;
}

export interface WebhookServerOptions {
  /** Shared secret (WEBHOOK_SECRET) required in both the URL path and the Authorization header. */
  secret: string;
  /** URL prefix before the secret token segment. Default: "/webhook/evolution". */
  basePath?: string;
  /** The ONLY business action: hand a fresh inbound message to the orchestrator. */
  onInbound: (msg: InboundMessage) => Promise<unknown>;
  recent?: RecentIds;
  onError?: (err: unknown) => void;
  /** Optional WhatsApp Cloud API webhook (GET verify + HMAC POST). Additive; Evolution stays as-is. */
  cloud?: CloudWebhookOptions;
  /** Per-phone serialization of onInbound (shared by both providers). Default: a new queue. */
  queue?: PerKeyQueue;
}

function defaultLogStatus(s: CloudStatus): void {
  const e = s.errors?.[0];
  console.log(
    `[webhook][cloud][status] id=${s.id} status=${s.status}${e ? ` error=${e.code}${e.title ? ` (${e.title})` : ""}` : ""}`,
  );
}

/**
 * Minimal webhook entrypoint over Node's built-in http (zero deps). It does NO business
 * logic: it verifies origin, parses/dedupes, acks fast, and hands fresh inbound messages
 * to onInbound (logging Cloud delivery statuses). Two independent paths:
 *   - Evolution (shared-secret, POST) at `/webhook/evolution/<token>` — unchanged.
 *   - Cloud API (GET verify + HMAC POST) at `/webhook/cloud` — only when `cloud` is set.
 */
export function createWebhookServer(opts: WebhookServerOptions): Server {
  const basePath = opts.basePath ?? "/webhook/evolution";
  const recent = opts.recent ?? new RecentIds();
  const onError =
    opts.onError ?? ((err: unknown) => console.error("[webhook] inbound processing failed", err));

  // Messages from the same phone are processed one at a time (T240); different phones overlap.
  const queue = opts.queue ?? new PerKeyQueue();

  const cloud = opts.cloud;
  const cloudBase = cloud?.basePath ?? "/webhook/cloud";
  const cloudRecent = cloud?.recent ?? new RecentIds();
  const logStatus = cloud?.onStatus ?? defaultLogStatus;

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";

    // --- Cloud API path (only when configured) ---
    if (cloud && url.startsWith(cloudBase)) {
      if (req.method === "GET") {
        const q = new URL(url, "http://localhost").searchParams;
        const challenge = verifyChallenge({
          mode: q.get("hub.mode") ?? undefined,
          token: q.get("hub.verify_token") ?? undefined,
          challenge: q.get("hub.challenge") ?? undefined,
          expected: cloud.verifyToken,
        });
        if (challenge === null) {
          res.writeHead(403).end();
          return;
        }
        res.writeHead(200, { "content-type": "text/plain" }).end(challenge);
        return;
      }
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("error", () => res.writeHead(400).end());
        req.on("end", () => {
          const rawBody = Buffer.concat(chunks); // HMAC must be over the RAW bytes
          const result = parseAndAcceptCloud({
            rawBody,
            signatureHeader: req.headers["x-hub-signature-256"] as string | undefined,
            appSecret: cloud.appSecret,
            seen: cloudRecent,
          });
          res.writeHead(result.status).end();
          for (const s of result.statuses) logStatus(s); // statuses: log only
          for (const m of result.msgs) {
            // Observability: phone masked (LGPD — last 4 digits); never logs message text.
            console.log(
              `[webhook][cloud][inbound] from=***${m.phone.slice(-4)} id=${m.providerMessageId}`,
            );
            void queue
              .run(m.phone, () => cloud.onInbound(m)) // messages → orchestrator
              .then((r) => {
                const status = (r as { status?: string } | null)?.status ?? "done";
                console.log(`[webhook][cloud][handled] id=${m.providerMessageId} status=${status}`);
              })
              .catch(onError);
          }
        });
        return;
      }
      res.writeHead(404).end();
      return;
    }

    // --- Evolution path (unchanged) ---
    if (req.method !== "POST" || !url.startsWith(basePath)) {
      res.writeHead(404).end();
      return;
    }
    const pathToken = url.slice(basePath.length).replace(/^\//, "").split(/[/?]/)[0];

    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("error", () => res.writeHead(400).end());
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const result = parseAndAccept({
        rawBody,
        authHeader: req.headers.authorization,
        pathToken,
        secret: opts.secret,
        seen: recent,
      });
      res.writeHead(result.status).end();
      const msg = result.msg;
      if (msg) void queue.run(msg.phone, () => opts.onInbound(msg)).catch(onError);
    });
  });
}

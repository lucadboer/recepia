import { createServer, type Server } from "node:http";
import type { InboundMessage } from "../agent/types";
import { parseAndAccept, RecentIds } from "./dispatch";

export interface WebhookServerOptions {
  /** Shared secret (WEBHOOK_SECRET) required in both the URL path and the Authorization header. */
  secret: string;
  /** URL prefix before the secret token segment. Default: "/webhook/evolution". */
  basePath?: string;
  /** The ONLY business action: hand a fresh inbound message to the orchestrator. */
  onInbound: (msg: InboundMessage) => Promise<unknown>;
  recent?: RecentIds;
  onError?: (err: unknown) => void;
}

/**
 * Minimal webhook entrypoint over Node's built-in http (zero deps). It does NO
 * business logic: it verifies origin, parses/dedupes via parseAndAccept, acks fast
 * with the resulting status, and — only for a fresh patient message — fires
 * onInbound in the background. handleInbound is idempotent (DB) and edge dedupe
 * guards re-delivery, so a fast ack with background processing is safe.
 */
export function createWebhookServer(opts: WebhookServerOptions): Server {
  const basePath = opts.basePath ?? "/webhook/evolution";
  const recent = opts.recent ?? new RecentIds();
  const onError =
    opts.onError ?? ((err: unknown) => console.error("[webhook] inbound processing failed", err));

  return createServer((req, res) => {
    if (req.method !== "POST" || !req.url || !req.url.startsWith(basePath)) {
      res.writeHead(404).end();
      return;
    }
    const pathToken = req.url.slice(basePath.length).replace(/^\//, "").split(/[/?]/)[0];

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
      if (result.msg) void opts.onInbound(result.msg).catch(onError);
    });
  });
}

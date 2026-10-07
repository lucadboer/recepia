import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { SpanKind } from "@opentelemetry/api";
import type { CloudStatus } from "../adapters/messaging/inbound/cloud-api-parser";
import type { InboundMessage } from "../agent/types";
import {
  WEBHOOK_HEADERS_TIMEOUT_MS,
  WEBHOOK_MAX_BODY_BYTES,
  WEBHOOK_REQUEST_TIMEOUT_MS,
} from "../config";
import { log } from "../telemetry/logger";
import { patientRef } from "../telemetry/pseudonym";
import { ATTR, SPAN, startRootSpan } from "../telemetry/tracing";
import { parseAndAcceptCloud, verifyChallenge } from "./cloud-dispatch";
import { parseAndAccept, RecentIds } from "./dispatch";
import { PerKeyQueue } from "./per-key-queue";

export interface CloudWebhookOptions {
  /** Exact path of the Cloud API webhook. Default: "/webhook/cloud". */
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
  /** Path prefix before the secret token segment. Default: "/webhook/evolution". */
  basePath?: string;
  /** The ONLY business action: hand a fresh inbound message to the orchestrator. */
  onInbound: (msg: InboundMessage) => Promise<unknown>;
  recent?: RecentIds;
  onError?: (err: unknown) => void;
  /** Optional WhatsApp Cloud API webhook (GET verify + HMAC POST). Additive; Evolution stays as-is. */
  cloud?: CloudWebhookOptions;
  /** Per-phone serialization of onInbound (shared by both providers). Default: a new queue. */
  queue?: PerKeyQueue;
  /** Request bodies above this size are refused with 413. Default: WEBHOOK_MAX_BODY_BYTES. */
  maxBodyBytes?: number;
  /** Readiness probe for GET /readyz (e.g. `SELECT 1`). Absent = always ready. */
  ready?: () => Promise<boolean>;
}

const READY_TIMEOUT_MS = 1_000;

function sendJson(res: ServerResponse, status: number, body: unknown, head: boolean): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(head ? undefined : JSON.stringify(body));
}

/** True only when the probe resolves true within the timeout; a throw or a hang is "not ready". */
async function probeReady(ready: (() => Promise<boolean>) | undefined): Promise<boolean> {
  if (!ready) return true;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), READY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([ready().catch(() => false), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function defaultLogStatus(s: CloudStatus): void {
  const e = s.errors?.[0];
  log.info(
    {
      event: "webhook.cloud.status",
      messageId: s.id,
      status: s.status,
      errorCode: e?.code,
      errorTitle: e?.title,
    },
    "cloud delivery status",
  );
}

/**
 * One root span per accepted patient message (FR-501), started on acceptance so the queue wait
 * is inside it; the turn runs as its child. Patient identified by pseudonym + masked phone.
 */
function traceInbound(
  channel: "evolution" | "cloud",
  msg: { phone: string; providerMessageId: string },
) {
  const patient = patientRef(msg.phone);
  return startRootSpan(
    SPAN.inbound,
    {
      [ATTR.channel]: channel,
      [ATTR.messageId]: msg.providerMessageId,
      [ATTR.patientId]: patient.id,
      [ATTR.patientPhoneMasked]: patient.phoneMasked,
    },
    SpanKind.CONSUMER,
  );
}

/**
 * Read the raw body with a hard size cap. Over the cap: answer 413 immediately (and ask the
 * client to close) instead of buffering an unbounded payload; `onDone` is never called.
 */
function readBody(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes: number,
  onDone: (raw: Buffer) => void,
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let refused = false;
  req.on("data", (c: Buffer) => {
    if (refused) return;
    size += c.length;
    if (size > maxBytes) {
      refused = true;
      res.writeHead(413, { connection: "close" }).end();
      req.resume(); // discard the rest; the socket closes after the response is flushed
      return;
    }
    chunks.push(c);
  });
  req.on("error", () => {
    if (!res.headersSent) res.writeHead(400).end();
  });
  req.on("end", () => {
    if (!refused) onDone(Buffer.concat(chunks));
  });
}

/**
 * Minimal webhook entrypoint over Node's built-in http (zero deps). It does NO business
 * logic: it verifies origin, parses/dedupes, acks fast, and hands fresh inbound messages
 * to onInbound (logging Cloud delivery statuses). Two independent paths, matched on the
 * EXACT pathname (a path that merely shares a prefix is a 404, T229):
 *   - Evolution (shared-secret, POST) at `/webhook/evolution/<token>` — exactly one segment.
 *   - Cloud API (GET verify + HMAC POST) at `/webhook/cloud` — only when `cloud` is set.
 * Edge-dedupe ids are recorded only after onInbound SUCCEEDED, so a redelivery after a failed
 * turn is processed again (at-least-once; DB idempotency by providerMessageId is the guarantee).
 */
export function createWebhookServer(opts: WebhookServerOptions): Server {
  const basePath = opts.basePath ?? "/webhook/evolution";
  const recent = opts.recent ?? new RecentIds();
  const onError =
    opts.onError ??
    ((err: unknown) =>
      log.error({ event: "webhook.inbound_failed", err }, "inbound processing failed"));
  const maxBodyBytes = opts.maxBodyBytes ?? WEBHOOK_MAX_BODY_BYTES;
  // Messages from the same phone are processed one at a time (T240); different phones overlap.
  const queue = opts.queue ?? new PerKeyQueue();

  const cloud = opts.cloud;
  const cloudBase = cloud?.basePath ?? "/webhook/cloud";
  const cloudRecent = cloud?.recent ?? new RecentIds();
  const logStatus = cloud?.onStatus ?? defaultLogStatus;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Node's parser accepts targets like "//" that WHATWG URL rejects; an uncaught throw
    // here would take the whole server down before any authentication ran.
    const parsed = parseTarget(req.url);
    if (!parsed) {
      res.writeHead(400).end();
      return;
    }
    const { pathname, searchParams } = parsed;

    // --- Health (FR-508): exact paths, no auth, no configuration revealed, not logged ---
    if (pathname === "/healthz" || pathname === "/readyz") {
      const head = req.method === "HEAD";
      if (req.method !== "GET" && !head) {
        res.writeHead(405, { allow: "GET, HEAD" }).end();
        return;
      }
      if (pathname === "/healthz") {
        sendJson(res, 200, { status: "ok" }, head);
        return;
      }
      void probeReady(opts.ready).then((ok) =>
        sendJson(res, ok ? 200 : 503, { status: ok ? "ready" : "not_ready" }, head),
      );
      return;
    }

    // --- Cloud API path (only when configured; exact match) ---
    if (cloud && pathname === cloudBase) {
      if (req.method === "GET") {
        const challenge = verifyChallenge({
          mode: searchParams.get("hub.mode") ?? undefined,
          token: searchParams.get("hub.verify_token") ?? undefined,
          challenge: searchParams.get("hub.challenge") ?? undefined,
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
        readBody(req, res, maxBodyBytes, (rawBody) => {
          // HMAC must be over the RAW bytes
          const result = parseAndAcceptCloud({
            rawBody,
            signatureHeader: req.headers["x-hub-signature-256"] as string | undefined,
            appSecret: cloud.appSecret,
            seen: cloudRecent,
          });
          res.writeHead(result.status).end();
          for (const s of result.statuses) logStatus(s); // statuses: log only
          for (const m of result.msgs) {
            // Observability: pseudonym + masked phone (LGPD); never the message text.
            const traced = traceInbound("cloud", m);
            log.info(
              {
                event: "webhook.inbound",
                channel: "cloud",
                messageId: m.providerMessageId,
                patient: patientRef(m.phone),
              },
              "inbound message accepted",
            );
            void queue
              .run(m.phone, () => traced.run(() => cloud.onInbound(m))) // messages → orchestrator
              .then((r) => {
                cloudRecent.add(m.providerMessageId); // dedupe only a SUCCESSFUL turn (T230)
                const status = (r as { status?: string } | null)?.status ?? "done";
                log.info(
                  {
                    event: "webhook.handled",
                    channel: "cloud",
                    messageId: m.providerMessageId,
                    status,
                  },
                  "inbound message handled",
                );
              })
              .catch(onError);
          }
        });
        return;
      }
      res.writeHead(404).end();
      return;
    }

    // --- Evolution path: POST basePath + "/" + <exactly one token segment> ---
    if (req.method !== "POST" || !pathname.startsWith(`${basePath}/`)) {
      res.writeHead(404).end();
      return;
    }
    const rest = pathname.slice(basePath.length + 1);
    if (rest.length === 0 || rest.includes("/")) {
      res.writeHead(404).end();
      return;
    }
    const pathToken = safeDecode(rest);

    readBody(req, res, maxBodyBytes, (rawBody) => {
      const result = parseAndAccept({
        rawBody: rawBody.toString("utf8"),
        authHeader: req.headers.authorization,
        pathToken,
        secret: opts.secret,
        seen: recent,
      });
      res.writeHead(result.status).end();
      const msg = result.msg;
      if (msg) {
        const traced = traceInbound("evolution", msg);
        log.info(
          {
            event: "webhook.inbound",
            channel: "evolution",
            messageId: msg.providerMessageId,
            patient: patientRef(msg.phone),
          },
          "inbound message accepted",
        );
        void queue
          .run(msg.phone, () => traced.run(() => opts.onInbound(msg)))
          .then((r) => {
            recent.add(msg.providerMessageId); // dedupe only a SUCCESSFUL turn (T230)
            const status = (r as { status?: string } | null)?.status ?? "done";
            log.info(
              {
                event: "webhook.handled",
                channel: "evolution",
                messageId: msg.providerMessageId,
                status,
              },
              "inbound message handled",
            );
          })
          .catch(onError);
      }
    });
  });

  // Slowloris / stalled-upload protection (node:http built-ins).
  server.headersTimeout = WEBHOOK_HEADERS_TIMEOUT_MS;
  server.requestTimeout = WEBHOOK_REQUEST_TIMEOUT_MS;
  return server;
}

function parseTarget(url: string | undefined): URL | null {
  try {
    return new URL(url ?? "/", "http://localhost");
  } catch {
    return null;
  }
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

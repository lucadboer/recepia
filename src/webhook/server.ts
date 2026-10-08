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
import { messageRef, patientRef } from "../telemetry/pseudonym";
import { ATTR, SPAN, startRootSpan } from "../telemetry/tracing";
import { parseAndAcceptCloud, verifyChallenge } from "./cloud-dispatch";
import { parseAndAccept } from "./dispatch";

export type InboundChannel = "evolution" | "cloud";

export interface CloudWebhookOptions {
  /** Exact path of the Cloud API webhook. Default: "/webhook/cloud". */
  basePath?: string;
  /** Verify token (GET challenge), chosen by you and set in the Meta dashboard. */
  verifyToken: string;
  /** Meta App Secret, used to validate the X-Hub-Signature-256 HMAC. */
  appSecret: string;
  /** Delivery-status receipts → log/observe only (never the orchestrator). */
  onStatus?: (s: CloudStatus) => void;
}

export interface WebhookServerOptions {
  /** Shared secret (WEBHOOK_SECRET) required in both the URL path and the Authorization header. */
  secret: string;
  /** Path prefix before the secret token segment. Default: "/webhook/evolution". */
  basePath?: string;
  /**
   * The ONLY business action (008): store a verified message durably. The webhook answers 200
   * only after this resolves, and a retryable 503 when it throws — an acknowledgment is a promise
   * that the message will be processed. Redeliveries are deduped by the store.
   */
  enqueue: (msg: InboundMessage, channel: InboundChannel) => Promise<void>;
  onError?: (err: unknown) => void;
  /** Optional WhatsApp Cloud API webhook (GET verify + HMAC POST). Additive; Evolution stays as-is. */
  cloud?: CloudWebhookOptions;
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
      messageRef: messageRef(s.id),
      status: s.status,
      errorCode: e?.code,
      errorTitle: e?.title,
    },
    "cloud delivery status",
  );
}

/**
 * One root span per accepted patient message (FR-501), around storing it; the worker's turn later
 * continues this trace through the stored traceparent (008). Patient = pseudonym + masked phone.
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
      [ATTR.messageRef]: messageRef(msg.providerMessageId),
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
 * logic: it verifies origin, parses, STORES each patient message durably and only then
 * acknowledges (008; logging Cloud delivery statuses). Two independent paths, matched on the
 * EXACT pathname (a path that merely shares a prefix is a 404, T229):
 *   - Evolution (shared-secret, POST) at `/webhook/evolution/<token>` — exactly one segment.
 *   - Cloud API (GET verify + HMAC POST) at `/webhook/cloud` — only when `cloud` is set.
 * A store failure answers 503 so the provider retries; the queue's unique key makes a redelivery
 * a no-op, and the in-process worker runs the turns.
 */
export function createWebhookServer(opts: WebhookServerOptions): Server {
  const basePath = opts.basePath ?? "/webhook/evolution";
  const onError =
    opts.onError ??
    ((err: unknown) =>
      log.error({ event: "webhook.store_failed", err }, "inbound message could not be stored"));
  const maxBodyBytes = opts.maxBodyBytes ?? WEBHOOK_MAX_BODY_BYTES;

  const cloud = opts.cloud;
  const cloudBase = cloud?.basePath ?? "/webhook/cloud";
  const logStatus = cloud?.onStatus ?? defaultLogStatus;

  // One readiness probe in flight at a time: under load, /readyz must not pile queries on the pool.
  let probing: Promise<boolean> | null = null;

  /**
   * Store the accepted messages, each inside its own root span (FR-501), then answer: 200 once
   * every message is stored, 503 if any store failed (already-stored ones are deduped on retry).
   */
  const storeThenAck = async (
    res: ServerResponse,
    channel: InboundChannel,
    msgs: InboundMessage[],
  ): Promise<void> => {
    try {
      for (const msg of msgs) {
        const traced = traceInbound(channel, msg);
        await traced.run(async () => {
          await opts.enqueue(msg, channel);
          log.info(
            {
              event: "webhook.inbound",
              channel,
              messageRef: messageRef(msg.providerMessageId),
              patient: patientRef(msg.phone),
            },
            "inbound message stored",
          );
        });
      }
      res.writeHead(200).end();
    } catch (err) {
      onError(err);
      if (!res.headersSent) res.writeHead(503, { "retry-after": "5" }).end();
    }
  };

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
      probing ??= probeReady(opts.ready).finally(() => {
        probing = null;
      });
      void probing.then((ok) =>
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
          });
          for (const s of result.statuses) logStatus(s); // statuses: log only
          if (result.status !== 200 || result.msgs.length === 0) {
            res.writeHead(result.status).end();
            return;
          }
          void storeThenAck(res, "cloud", result.msgs);
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
      });
      if (result.status !== 200 || !result.msg) {
        res.writeHead(result.status).end();
        return;
      }
      void storeThenAck(res, "evolution", [result.msg]);
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

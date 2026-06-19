import crypto from "node:crypto";
import { parseEvolutionInbound } from "../adapters/messaging/inbound/evolution-parser";
import type { InboundMessage } from "../agent/types";

/**
 * Bounded FIFO set of recently-seen provider message ids for EDGE dedupe. This is
 * an optimization to avoid redundant LLM work on webhook re-delivery; it is in-memory
 * and does NOT survive a restart. The real idempotency guarantee is the orchestrator's
 * DB-backed dedupe by providerMessageId (FR-207).
 */
export class RecentIds {
  private readonly ids = new Set<string>();
  private readonly order: string[] = [];
  constructor(private readonly max = 500) {}

  has(id: string): boolean {
    return this.ids.has(id);
  }

  add(id: string): void {
    if (this.ids.has(id)) return;
    this.ids.add(id);
    this.order.push(id);
    if (this.order.length > this.max) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.ids.delete(evicted);
    }
  }
}

/**
 * Timing-safe secret comparison. Evolution webhooks are NOT HMAC-signed, so origin
 * is verified with a shared secret. NEVER use `===` (it short-circuits and leaks
 * length/match timing). A length mismatch fails as unauthorized WITHOUT a
 * short-circuited byte-by-byte compare (crypto.timingSafeEqual requires equal-length
 * buffers and would otherwise throw).
 */
export function safeEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export interface DispatchInput {
  rawBody: string;
  /** The HTTP Authorization header value (may carry a "Bearer " prefix). */
  authHeader: string | undefined;
  /** The secret token segment taken from the URL path. */
  pathToken: string | undefined;
  /** The expected shared secret (WEBHOOK_SECRET). */
  secret: string;
  seen: RecentIds;
}

export interface DispatchResult {
  status: number;
  msg?: InboundMessage;
}

/**
 * Pure webhook routing: verify origin, parse, normalize, edge-dedupe. Contains NO
 * business logic — it never calls the orchestrator; it only decides the HTTP status
 * and, when the request is a fresh patient text message, returns the normalized
 * InboundMessage for the caller to hand to handleInbound.
 */
export function parseAndAccept(input: DispatchInput): DispatchResult {
  // 1. Origin check (defense in depth): BOTH the path token AND the Authorization
  //    header must match the shared secret, compared timing-safely.
  const headerToken = stripBearer(input.authHeader);
  const pathOk = safeEqual(input.pathToken ?? "", input.secret);
  const headerOk = safeEqual(headerToken, input.secret);
  if (!pathOk || !headerOk) return { status: 401 };

  // 2. Parse the JSON body.
  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    return { status: 400 };
  }

  // 3. Normalize. Non-text / status / group / own-echo events are ignored (200 no-op).
  const msg = parseEvolutionInbound(payload);
  if (!msg) return { status: 200 };

  // 4. Edge dedupe by providerMessageId (optimization; DB idempotency is the guarantee).
  if (input.seen.has(msg.providerMessageId)) return { status: 200 };
  input.seen.add(msg.providerMessageId);
  return { status: 200, msg };
}

function stripBearer(header: string | undefined): string {
  if (!header) return "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : header;
}

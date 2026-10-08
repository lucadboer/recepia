import crypto from "node:crypto";
import { parseEvolutionInbound } from "../adapters/messaging/inbound/evolution-parser.ts";
import type { InboundMessage } from "../agent/types.ts";

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
}

export interface DispatchResult {
  status: number;
  msg?: InboundMessage;
}

/**
 * Pure webhook routing: verify origin, parse, normalize. Contains NO business logic — it only
 * decides the HTTP status and, when the request is a patient text message, returns the normalized
 * InboundMessage for the caller to store (008: the durable queue's unique key dedupes redeliveries).
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
  return { status: 200, msg };
}

function stripBearer(header: string | undefined): string {
  if (!header) return "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : header;
}

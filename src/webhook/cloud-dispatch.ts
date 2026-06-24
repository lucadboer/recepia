import crypto from "node:crypto";
import {
  type CloudStatus,
  parseCloudApiInbound,
  parseCloudApiStatuses,
} from "../adapters/messaging/inbound/cloud-api-parser";
import type { InboundMessage } from "../agent/types";
import { type RecentIds, safeEqual } from "./dispatch";

/**
 * WhatsApp Cloud API webhook routing — distinct from Evolution (dispatch.ts):
 *   - GET verify challenge (hub.mode/hub.verify_token/hub.challenge)
 *   - POST validated by HMAC X-Hub-Signature-256 over the RAW body, with the App Secret
 *   - value.messages[] = inbound patient messages → orchestrator; value.statuses[] = delivery
 *     receipts → log only, NEVER the orchestrator.
 * Contains NO business logic. Sources:
 *   https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks/
 *   https://developers.facebook.com/docs/graph-api/webhooks/getting-started/
 */

/** GET verification: returns the challenge to echo (200) when valid, or null (→ 403). */
export function verifyChallenge(input: {
  mode: string | undefined;
  token: string | undefined;
  challenge: string | undefined;
  expected: string;
}): string | null {
  if (input.mode !== "subscribe") return null;
  if (!input.token || !safeEqual(input.token, input.expected)) return null;
  return input.challenge ?? "";
}

/** HMAC-SHA256 over the RAW body bytes (never re-serialized JSON), timing-safe vs the header. */
export function verifySignature(
  rawBody: Buffer,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header) return false;
  const expected = `sha256=${crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(header, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false; // mismatch w/o a short-circuited byte compare
  return crypto.timingSafeEqual(a, b);
}

export interface CloudDispatchInput {
  rawBody: Buffer;
  signatureHeader: string | undefined;
  appSecret: string;
  seen: RecentIds;
}

export interface CloudDispatchResult {
  status: number;
  /** Fresh inbound patient messages → onInbound. Empty for status-only payloads. */
  msgs: InboundMessage[];
  /** Delivery receipts → log only, never onInbound. */
  statuses: CloudStatus[];
}

/**
 * Verify origin (HMAC) → parse → split: messages[] become fresh inbound (deduped),
 * statuses[] are returned for logging only. A status-only payload yields `msgs: []`.
 */
export function parseAndAcceptCloud(input: CloudDispatchInput): CloudDispatchResult {
  if (!verifySignature(input.rawBody, input.signatureHeader, input.appSecret)) {
    return { status: 401, msgs: [], statuses: [] };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody.toString("utf8"));
  } catch {
    return { status: 400, msgs: [], statuses: [] };
  }

  const statuses = parseCloudApiStatuses(payload); // log-only, never routed
  const msgs: InboundMessage[] = [];
  for (const m of parseCloudApiInbound(payload)) {
    if (input.seen.has(m.providerMessageId)) continue; // edge dedupe
    input.seen.add(m.providerMessageId);
    msgs.push(m);
  }
  return { status: 200, msgs, statuses };
}

import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseAndAcceptCloud,
  verifyChallenge,
  verifySignature,
} from "../../src/webhook/cloud-dispatch";
import { RecentIds } from "../../src/webhook/dispatch";

const SECRET = "app-secret-abc";

function sign(body: string, secret = SECRET): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

const inbound = (id = "wamid.IN1", text = "oi") =>
  JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15556515037", phone_number_id: "PNID" },
              contacts: [{ wa_id: "5516981526867" }],
              messages: [
                {
                  from: "5516981526867",
                  id,
                  type: "text",
                  text: { body: text },
                  timestamp: "1700000000",
                },
              ],
            },
          },
        ],
      },
    ],
  });

const statusOnly = (id = "wamid.ST1", status = "failed", code: number | null = 131031) =>
  JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15556515037", phone_number_id: "PNID" },
              statuses: [
                {
                  id,
                  status,
                  timestamp: "1700000000",
                  recipient_id: "5516981526867",
                  ...(code ? { errors: [{ code, title: "Business Account locked" }] } : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  });

describe("verifyChallenge (GET webhook verification)", () => {
  it("echoes the challenge when mode=subscribe and the verify token matches", () => {
    expect(
      verifyChallenge({ mode: "subscribe", token: "vt", challenge: "CHAL", expected: "vt" }),
    ).toBe("CHAL");
  });
  it("returns null for a wrong verify token", () => {
    expect(
      verifyChallenge({ mode: "subscribe", token: "WRONG", challenge: "CHAL", expected: "vt" }),
    ).toBeNull();
  });
  it("returns null when mode is not subscribe", () => {
    expect(
      verifyChallenge({ mode: "unsubscribe", token: "vt", challenge: "CHAL", expected: "vt" }),
    ).toBeNull();
  });
});

describe("verifySignature (X-Hub-Signature-256 HMAC over raw body)", () => {
  it("accepts a correct signature", () => {
    const body = inbound();
    expect(verifySignature(Buffer.from(body), sign(body), SECRET)).toBe(true);
  });
  it("rejects a tampered body", () => {
    const body = inbound();
    const sig = sign(body);
    expect(verifySignature(Buffer.from(`${body} `), sig, SECRET)).toBe(false);
  });
  it("rejects a missing header", () => {
    const body = inbound();
    expect(verifySignature(Buffer.from(body), undefined, SECRET)).toBe(false);
  });
});

describe("parseAndAcceptCloud — messages[] vs statuses[] are distinct", () => {
  it("inbound message → 200, one msg, no statuses", () => {
    const body = inbound("wamid.IN1", "quero marcar");
    const r = parseAndAcceptCloud({
      rawBody: Buffer.from(body),
      signatureHeader: sign(body),
      appSecret: SECRET,
      seen: new RecentIds(),
    });
    expect(r.status).toBe(200);
    expect(r.msgs).toHaveLength(1);
    expect(r.msgs[0]).toMatchObject({
      phone: "+5516981526867",
      text: "quero marcar",
      providerMessageId: "wamid.IN1",
    });
    expect(r.statuses).toHaveLength(0);
  });

  it("status-only payload → 200, ZERO msgs, status captured (id/status/error code)", () => {
    const body = statusOnly("wamid.ST1", "failed", 131031);
    const r = parseAndAcceptCloud({
      rawBody: Buffer.from(body),
      signatureHeader: sign(body),
      appSecret: SECRET,
      seen: new RecentIds(),
    });
    expect(r.status).toBe(200);
    expect(r.msgs).toHaveLength(0); // never routed to onInbound
    expect(r.statuses).toHaveLength(1);
    expect(r.statuses[0]).toMatchObject({ id: "wamid.ST1", status: "failed" });
    expect(r.statuses[0].errors?.[0]?.code).toBe(131031);
  });

  it("invalid signature → 401, nothing parsed", () => {
    const body = inbound();
    const r = parseAndAcceptCloud({
      rawBody: Buffer.from(body),
      signatureHeader: "sha256=deadbeef",
      appSecret: SECRET,
      seen: new RecentIds(),
    });
    expect(r.status).toBe(401);
    expect(r.msgs).toHaveLength(0);
    expect(r.statuses).toHaveLength(0);
  });

  it("malformed JSON (validly signed) → 400", () => {
    const body = "{not json";
    const r = parseAndAcceptCloud({
      rawBody: Buffer.from(body),
      signatureHeader: sign(body),
      appSecret: SECRET,
      seen: new RecentIds(),
    });
    expect(r.status).toBe(400);
  });

  it("edge-dedupes a repeated inbound id", () => {
    const seen = new RecentIds();
    const body = inbound("wamid.DUP");
    const sig = sign(body);
    const first = parseAndAcceptCloud({
      rawBody: Buffer.from(body),
      signatureHeader: sig,
      appSecret: SECRET,
      seen,
    });
    const second = parseAndAcceptCloud({
      rawBody: Buffer.from(body),
      signatureHeader: sig,
      appSecret: SECRET,
      seen,
    });
    expect(first.msgs).toHaveLength(1);
    expect(second.msgs).toHaveLength(0);
  });
});

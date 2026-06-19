import { describe, expect, it } from "vitest";
import { parseCloudApiInbound } from "../../src/adapters/messaging/inbound/cloud-api-parser";

function envelope(messages: unknown[], statuses?: unknown[]) {
  return {
    object: "whatsapp_business_account",
    entry: [{ changes: [{ value: { messages, statuses } }] }],
  };
}

describe("parseCloudApiInbound", () => {
  it("parses a single text message", () => {
    const out = parseCloudApiInbound(
      envelope([{ from: "5511999999999", id: "wamid.1", type: "text", text: { body: "oi" } }]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      phone: "+5511999999999",
      text: "oi",
      providerMessageId: "wamid.1",
    });
  });

  it("returns multiple messages from a batch", () => {
    const out = parseCloudApiInbound(
      envelope([
        { from: "551111", id: "a", type: "text", text: { body: "um" } },
        { from: "552222", id: "b", type: "text", text: { body: "dois" } },
      ]),
    );
    expect(out.map((m) => m.providerMessageId)).toEqual(["a", "b"]);
  });

  it("ignores non-text messages and status-only payloads", () => {
    expect(
      parseCloudApiInbound(envelope([{ from: "551111", id: "c", type: "image" }])),
    ).toHaveLength(0);
    expect(parseCloudApiInbound(envelope([], [{ status: "delivered" }]))).toHaveLength(0);
    expect(parseCloudApiInbound({})).toHaveLength(0);
  });
});

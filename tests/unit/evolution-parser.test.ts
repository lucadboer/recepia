import { describe, expect, it } from "vitest";
import { parseEvolutionInbound } from "../../src/adapters/messaging/inbound/evolution-parser";

function textPayload(over: Record<string, unknown> = {}) {
  return {
    event: "messages.upsert",
    data: {
      key: { remoteJid: "5511999999999@s.whatsapp.net", fromMe: false, id: "EVT1" },
      message: { conversation: "quero marcar uma limpeza" },
      pushName: "João",
      ...over,
    },
  };
}

describe("parseEvolutionInbound", () => {
  it("parses a text message", () => {
    expect(parseEvolutionInbound(textPayload())).toEqual({
      phone: "+5511999999999",
      text: "quero marcar uma limpeza",
      providerMessageId: "EVT1",
    });
  });

  it("ignores our own outbound echo (fromMe)", () => {
    expect(
      parseEvolutionInbound(
        textPayload({ key: { remoteJid: "5511999999999@s.whatsapp.net", fromMe: true, id: "X" } }),
      ),
    ).toBeNull();
  });

  it("ignores group messages", () => {
    expect(
      parseEvolutionInbound(
        textPayload({ key: { remoteJid: "12345@g.us", fromMe: false, id: "G" } }),
      ),
    ).toBeNull();
  });

  it("ignores non-text payloads and other events", () => {
    expect(parseEvolutionInbound(textPayload({ message: {} }))).toBeNull();
    expect(parseEvolutionInbound({ event: "messages.update", data: {} })).toBeNull();
    expect(parseEvolutionInbound({})).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  CloudApiMessaging,
  type FetchLike,
} from "../../src/adapters/messaging/cloud-api-messaging";
import { MessagingSendError, NotConfigured } from "../../src/domain/errors";

function recorder(res: { ok: boolean; status: number; text?: string }) {
  const calls: {
    url: string;
    init: { method: string; headers: Record<string, string>; body: string };
  }[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return { ok: res.ok, status: res.status, text: async () => res.text ?? "" };
  };
  return { calls, fetchFn };
}

describe("CloudApiMessaging", () => {
  it("POSTs the Graph API with Bearer auth and the text payload, digits-only recipient", async () => {
    const { calls, fetchFn } = recorder({ ok: true, status: 200 });
    const m = new CloudApiMessaging("123456", "TOK", "v23.0", fetchFn);

    await m.sendMessage("+55 (16) 98152-6867", "Olá, tudo bem?");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://graph.facebook.com/v23.0/123456/messages");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers.Authorization).toBe("Bearer TOK");
    expect(calls[0].init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(calls[0].init.body)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "5516981526867",
      type: "text",
      text: { preview_url: false, body: "Olá, tudo bem?" },
    });
  });

  it("defaults the Graph API version when none is provided", async () => {
    const { calls, fetchFn } = recorder({ ok: true, status: 200 });
    const m = new CloudApiMessaging("p1", "TOK", "", fetchFn);
    await m.sendMessage("+5516981526867", "x");
    expect(calls[0].url).toBe("https://graph.facebook.com/v23.0/p1/messages");
  });

  it.each([
    ["", "TOK"],
    ["p1", ""],
    ["", ""],
  ])("throws NotConfigured for an incomplete cred combo (id=%j token=%j)", (id, token) => {
    expect(() => new CloudApiMessaging(id, token)).toThrow(NotConfigured);
  });

  it("throws MessagingSendError with the status on a non-2xx response", async () => {
    const { fetchFn } = recorder({ ok: false, status: 401, text: "invalid token" });
    const m = new CloudApiMessaging("p1", "TOK", "v23.0", fetchFn);
    await expect(m.sendMessage("+5516981526867", "x")).rejects.toThrow(MessagingSendError);
    await expect(m.sendMessage("+5516981526867", "x")).rejects.toThrow(/HTTP 401/);
  });
});

describe("review fix H3 — provider bodies are masked and bounded", () => {
  it("masks an echoed recipient and truncates long bodies", async () => {
    const { fetchFn } = recorder({
      ok: false,
      status: 400,
      text: `recipient 5516981526867 not allowed ${"x".repeat(1000)}`,
    });
    const m = new CloudApiMessaging("p1", "TOK", "v23.0", fetchFn);
    const err = await m.sendMessage("+5516981526867", "x").catch((e) => e);
    expect(err.message).not.toContain("5516981526867");
    expect(err.message.length).toBeLessThan(400);
  });
});

describe("CloudApiMessaging — templates (007 FR-707)", () => {
  it("sends the approved template with body text parameters when one is given", async () => {
    const { calls, fetchFn } = recorder({ ok: true, status: 200 });
    const m = new CloudApiMessaging("123456", "TOK", "v23.0", fetchFn);
    await m.sendMessage("+5531900000701", "texto de reserva", {
      name: "lembrete_consulta",
      language: "pt_BR",
      params: ["Ana", "limpeza", "18/06/2026 às\n09:00"],
    });
    expect(JSON.parse(calls[0].init.body)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "5531900000701",
      type: "template",
      template: {
        name: "lembrete_consulta",
        language: { code: "pt_BR" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "Ana" },
              { type: "text", text: "limpeza" },
              { type: "text", text: "18/06/2026 às 09:00" }, // line breaks are not allowed
            ],
          },
        ],
      },
    });
  });
});

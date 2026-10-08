import { describe, expect, it } from "vitest";
import {
  EvolutionMessaging,
  type FetchLike,
} from "../../src/adapters/messaging/evolution-messaging";
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

describe("EvolutionMessaging", () => {
  it("throws NotConfigured when creds are missing", () => {
    expect(() => new EvolutionMessaging("", "", "")).toThrow(NotConfigured);
  });

  it("POSTs sendText with apikey header and { number, text }, stripping non-digits and trailing slash", async () => {
    const { calls, fetchFn } = recorder({ ok: true, status: 201 });
    const m = new EvolutionMessaging("https://evo.example.com/", "k-123", "clinica", fetchFn);

    await m.sendMessage("+55 (31) 99999-8888", "Olá, tudo bem?");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://evo.example.com/message/sendText/clinica");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers.apikey).toBe("k-123");
    expect(calls[0].init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(calls[0].init.body)).toEqual({
      number: "5531999998888",
      text: "Olá, tudo bem?",
    });
  });

  it("throws MessagingSendError on a non-2xx response", async () => {
    const { fetchFn } = recorder({ ok: false, status: 400, text: "bad request" });
    const m = new EvolutionMessaging("https://evo.example.com", "k", "i", fetchFn);

    await expect(m.sendMessage("+5531999998888", "x")).rejects.toThrow(MessagingSendError);
  });

  // Fail-fast must trigger if ANY of the three creds is missing, not only when all are.
  it.each([
    ["", "k", "i"],
    ["b", "", "i"],
    ["b", "k", ""],
    ["", "", "i"],
    ["", "k", ""],
    ["b", "", ""],
    ["", "", ""],
  ])(
    "throws NotConfigured for an incomplete cred combo (base=%j key=%j inst=%j)",
    (base, key, inst) => {
      expect(() => new EvolutionMessaging(base, key, inst)).toThrow(NotConfigured);
    },
  );

  it("includes the HTTP status (and provider detail) in the MessagingSendError message", async () => {
    const { fetchFn } = recorder({ ok: false, status: 502, text: "upstream down" });
    const m = new EvolutionMessaging("https://evo.example.com", "k", "i", fetchFn);

    await expect(m.sendMessage("+5531999998888", "x")).rejects.toThrow(/HTTP 502/);
    await expect(m.sendMessage("+5531999998888", "x")).rejects.toThrow(/upstream down/);
  });
});

describe("review fix H3 — provider bodies are masked in the error message", () => {
  it("an echoed number / JID never reaches MessagingSendError.message", async () => {
    const body = JSON.stringify({
      response: {
        message: [{ exists: false, jid: "5531999998888@s.whatsapp.net", number: "5531999998888" }],
      },
    });
    const { fetchFn } = recorder({ ok: false, status: 400, text: body });
    const m = new EvolutionMessaging("https://evo.example.com", "k", "i", fetchFn);
    const err = await m.sendMessage("+5531999998888", "x").catch((e) => e);
    expect(err.message).toMatch(/HTTP 400/);
    expect(err.message).not.toContain("5531999998888");
    expect(err.message).toContain("***8888");
  });
});

describe("EvolutionMessaging — templates are a Cloud-only concept (007)", () => {
  it("sends the text body even when a template is given", async () => {
    const { calls, fetchFn } = recorder({ ok: true, status: 201 });
    const m = new EvolutionMessaging("https://evo.example.com", "k", "clinica", fetchFn);
    await m.sendMessage("+5531900000701", "Lembrete…", {
      name: "t",
      language: "pt_BR",
      params: ["a"],
    });
    expect(JSON.parse(calls[0].init.body)).toEqual({ number: "5531900000701", text: "Lembrete…" });
  });
});

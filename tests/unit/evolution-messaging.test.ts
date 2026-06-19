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
});

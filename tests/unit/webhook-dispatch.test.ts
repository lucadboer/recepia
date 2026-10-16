import { describe, expect, it } from "vitest";
import { parseAndAccept, safeEqual } from "../../src/webhook/dispatch";

const SECRET = "shared-secret-123"; // length 17

const upsert = (id = "M1", text = "oi") =>
  JSON.stringify({
    event: "messages.upsert",
    data: {
      key: { remoteJid: "5531999998888@s.whatsapp.net", fromMe: false, id },
      message: { conversation: text },
    },
  });

function base(over: Partial<Parameters<typeof parseAndAccept>[0]> = {}) {
  return {
    rawBody: upsert(),
    authHeader: SECRET,
    pathToken: SECRET,
    secret: SECRET,
    ...over,
  };
}

describe("safeEqual (timing-safe, never ===)", () => {
  it("true only for byte-equal strings; false for same- and different-length mismatches", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false); // same length, differs
    expect(safeEqual("abc", "abcd")).toBe(false); // different length
    expect(safeEqual("", "x")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("parseAndAccept", () => {
  it("accepts a valid signed messages.upsert -> 200 + normalized msg", () => {
    const r = parseAndAccept(base());
    expect(r.status).toBe(200);
    expect(r.msg).toMatchObject({ phone: "+5531999998888", text: "oi", providerMessageId: "M1" });
  });

  it("rejects a wrong secret of the SAME length -> 401, no msg", () => {
    const wrong = "shared-secret-XYZ"; // same length as SECRET
    expect(wrong.length).toBe(SECRET.length);
    const r = parseAndAccept(base({ authHeader: wrong, pathToken: wrong }));
    expect(r.status).toBe(401);
    expect(r.msg).toBeUndefined();
  });

  it("rejects a wrong secret of DIFFERENT length -> 401, no msg", () => {
    const r = parseAndAccept(base({ authHeader: "short", pathToken: "short" }));
    expect(r.status).toBe(401);
    expect(r.msg).toBeUndefined();
  });

  it("requires BOTH path token and header to match (header ok, path wrong -> 401)", () => {
    const r = parseAndAccept(base({ pathToken: "totally-different-token" }));
    expect(r.status).toBe(401);
  });

  it("returns 400 on malformed JSON", () => {
    const r = parseAndAccept(base({ rawBody: "{not json" }));
    expect(r.status).toBe(400);
  });

  it("ignores non-message events -> 200, no msg", () => {
    const r = parseAndAccept(
      base({ rawBody: JSON.stringify({ event: "messages.update", data: {} }) }),
    );
    expect(r.status).toBe(200);
    expect(r.msg).toBeUndefined();
  });

  it("returns the message on every valid delivery — redeliveries are deduped by the durable store (008)", () => {
    expect(parseAndAccept(base()).msg?.providerMessageId).toBe("M1");
    expect(parseAndAccept(base()).msg?.providerMessageId).toBe("M1");
  });

  it("rejects when the path token matches but the header is WRONG -> 401", () => {
    const r = parseAndAccept(base({ authHeader: "totally-different-token" }));
    expect(r.status).toBe(401);
    expect(r.msg).toBeUndefined();
  });

  it("rejects when the path token matches but the header is ABSENT -> 401", () => {
    const r = parseAndAccept(base({ authHeader: undefined }));
    expect(r.status).toBe(401);
    expect(r.msg).toBeUndefined();
  });

  it("accepts an Authorization header carrying a 'Bearer ' prefix", () => {
    const r = parseAndAccept(base({ authHeader: `Bearer ${SECRET}` }));
    expect(r.status).toBe(200);
    expect(r.msg).toBeDefined();
  });

  it("verifies auth BEFORE parsing: bad secret + malformed JSON -> 401 (not 400)", () => {
    const r = parseAndAccept(
      base({ authHeader: "wrong", pathToken: "wrong", rawBody: "{not json" }),
    );
    expect(r.status).toBe(401);
  });
});

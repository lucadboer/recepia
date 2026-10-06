import { describe, expect, it } from "vitest";
import { parseAndAccept, RecentIds, safeEqual } from "../../src/webhook/dispatch";

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
    seen: new RecentIds(),
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

  it("skips an id already recorded in `seen` (200, no msg) but does NOT record ids itself [T230]", () => {
    const seen = new RecentIds();
    const first = parseAndAccept(base({ seen }));
    expect(first.msg).toBeDefined();
    // Recording is the server's job, AFTER onInbound succeeded — so a failed turn can be
    // re-processed on redelivery. The pure parser only consults the set.
    expect(seen.has("M1")).toBe(false);
    const again = parseAndAccept(base({ seen }));
    expect(again.msg).toBeDefined();

    seen.add("M1");
    const skipped = parseAndAccept(base({ seen }));
    expect(skipped.status).toBe(200);
    expect(skipped.msg).toBeUndefined();
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

describe("RecentIds (bounded FIFO edge dedupe)", () => {
  it("evicts the oldest id once `max` is exceeded", () => {
    const seen = new RecentIds(2);
    seen.add("A");
    seen.add("B");
    seen.add("C"); // exceeds max=2 -> A evicted
    expect(seen.has("A")).toBe(false);
    expect(seen.has("B")).toBe(true);
    expect(seen.has("C")).toBe(true);
  });

  it("a duplicate add does not refresh FIFO ordering", () => {
    const seen = new RecentIds(2);
    seen.add("A");
    seen.add("B");
    seen.add("B"); // duplicate — must NOT move B to the back nor evict A
    seen.add("C"); // still evicts the genuine oldest (A)
    expect(seen.has("A")).toBe(false);
    expect(seen.has("B")).toBe(true);
    expect(seen.has("C")).toBe(true);
  });
});

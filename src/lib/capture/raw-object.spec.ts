import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { RawObjectCorruptError, decodeRawObject, encodeRawObject, rawObjectRelativeKey } from "./raw-object.js";

// STORY-181 AC1/AC2 - the raw capture object: its key and its bytes.

const ID = "0197a000-0000-7000-8000-0000000000aa";

describe("STORY-181 AC1 · rawObjectRelativeKey", () => {
  it("181-K1 · is {yyyy}/{mm}/{id}.json.gz in UTC", () => {
    expect(rawObjectRelativeKey(new Date(Date.UTC(2026, 9, 23, 12)), ID)).toBe(`2026/10/${ID}.json.gz`);
  });

  it("181-K2 · uses the UTC month at a month boundary, not the host's", () => {
    expect(rawObjectRelativeKey(new Date("2026-11-30T23:59:59.999Z"), ID)).toBe(`2026/11/${ID}.json.gz`);
    expect(rawObjectRelativeKey(new Date("2026-12-01T00:00:00.000Z"), ID)).toBe(`2026/12/${ID}.json.gz`);
    expect(rawObjectRelativeKey(new Date("2027-01-01T00:00:00.000Z"), ID)).toBe(`2027/01/${ID}.json.gz`);
  });

  it("181-K3 · refuses an id that is not a lowercase uuid", () => {
    expect(() => rawObjectRelativeKey(new Date(), "../escape")).toThrow();
    expect(() => rawObjectRelativeKey(new Date(), ID.toUpperCase())).toThrow();
  });
});

describe("STORY-181 AC1/AC2 · encode and decode", () => {
  it("181-E1 · round-trips the body byte-for-byte, including markup, astral characters and structured fields", () => {
    const body = {
      format: "markdown",
      text: "HubSpot <script>alert(1)</script> \u{1F600} \u0000 end",
      structured_citations: [{ url: "https://a.test/x", slot: 0 }],
    };
    expect(decodeRawObject(encodeRawObject(body))).toEqual(body);
  });

  it("181-E2 · the stored bytes are gzip", () => {
    const bytes = encodeRawObject({ format: "plaintext", text: "x" });
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
  });

  it("181-E3 · an empty answer is a valid object (a refusal is data)", () => {
    expect(decodeRawObject(encodeRawObject({ format: "plaintext", text: "" })).text).toBe("");
  });

  it("181-E4 · bytes that are not gzip are corrupt, never an empty answer", () => {
    expect(() => decodeRawObject(Buffer.from("not gzip"))).toThrow(RawObjectCorruptError);
  });

  it("181-E5 · gzip of something that is not a raw body is corrupt", () => {
    expect(() => decodeRawObject(gzipSync(Buffer.from("[]")))).toThrow(RawObjectCorruptError);
    expect(() => decodeRawObject(gzipSync(Buffer.from('{"text":7}')))).toThrow(RawObjectCorruptError);
    expect(() => decodeRawObject(gzipSync(Buffer.from("{")))).toThrow(RawObjectCorruptError);
  });

  it("181-E6 · a decompression bomb is refused rather than inflated", () => {
    const bomb = gzipSync(Buffer.alloc(40 * 1024 * 1024, 97));
    expect(() => decodeRawObject(bomb)).toThrow(RawObjectCorruptError);
  });
});

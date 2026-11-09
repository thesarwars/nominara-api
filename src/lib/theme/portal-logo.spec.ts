import { describe, expect, it } from "vitest";
import { PORTAL_LOGO_DATA_URL_MAX_LENGTH, PORTAL_LOGO_MAX_BYTES, portalLogoDataUrlSchema } from "../../../contracts/portal/index.js";
import { portalLogoDataUrl } from "./portal-logo.js";

// Owner decision 71 (a) — the portal's logo is an enveloped data: URL, at most 256 KB, built from bytes that pass the upload's own checks.
function png(w: number, h: number, pad = 0): Uint8Array {
  const b = Buffer.alloc(33 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

describe("STORY-098 d.71 (a) · portalLogoDataUrl", () => {
  it("the cap is exactly 256 KB and the contract publishes the same number", () => {
    expect(PORTAL_LOGO_MAX_BYTES).toBe(262_144);
  });

  it("a PNG logo within the cap becomes data:image/png;base64,<the bytes> and passes the contract's closed envelope", () => {
    const bytes = png(200, 60);
    const result = portalLogoDataUrl(bytes);
    expect(result).toEqual({ ok: true, dataUrl: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}` });
    if (result.ok) expect(portalLogoDataUrlSchema.safeParse(result.dataUrl).success).toBe(true);
  });

  it("a logo of exactly 256 KB is accepted and 256 KB + 1 is refused as too_large, before any decoding", () => {
    expect(portalLogoDataUrl(png(200, 60, PORTAL_LOGO_MAX_BYTES - 33))).toMatchObject({ ok: true });
    expect(portalLogoDataUrl(png(200, 60, PORTAL_LOGO_MAX_BYTES - 33 + 1))).toEqual({ ok: false, reason: "too_large" });
  });

  it("the largest accepted logo's data URL fits the contract's length bound", () => {
    const result = portalLogoDataUrl(png(200, 60, PORTAL_LOGO_MAX_BYTES - 33));
    expect(result.ok && result.dataUrl.length <= PORTAL_LOGO_DATA_URL_MAX_LENGTH).toBe(true);
    if (result.ok) expect(portalLogoDataUrlSchema.safeParse(result.dataUrl).success).toBe(true);
  });

  it("an SVG, HTML, an empty file and bytes that are no image are refused as invalid (the envelope is never opened for them)", () => {
    for (const bytes of [
      new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      new TextEncoder().encode("<html><script>alert(1)</script></html>"),
      new Uint8Array(0),
      new Uint8Array(500).fill(7),
    ]) {
      expect(portalLogoDataUrl(bytes)).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("a logo over the dimension limit is refused as invalid, exactly as the upload would", () => {
    expect(portalLogoDataUrl(png(1201, 100))).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("STORY-098 d.71 (a) · the portal logo envelope in the contract", () => {
  const ok = "data:image/png;base64,iVBORw0KGgo=";
  it("accepts the three image types and nothing else", () => {
    for (const type of ["png", "jpeg", "webp"]) expect(portalLogoDataUrlSchema.safeParse(`data:image/${type};base64,AAAA`).success).toBe(true);
    for (const bad of [
      "data:image/svg+xml;base64,AAAA",
      "data:text/html;base64,AAAA",
      "data:image/png;charset=utf-8;base64,AAAA",
      "data:image/png,AAAA",
      "data:image/png;base64,AAAA\" onerror=\"x",
      "https://cdn.example/logo.png",
      "/v1/themes/x/assets/logo_light",
      "javascript:alert(1)",
      `${ok}!`,
      `${ok} `,
      "data:image/png;base64,",
    ]) {
      expect(portalLogoDataUrlSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
  it("refuses a data URL longer than 256 KB of bytes allows", () => {
    expect(portalLogoDataUrlSchema.safeParse("data:image/png;base64," + "A".repeat(PORTAL_LOGO_DATA_URL_MAX_LENGTH)).success).toBe(false);
  });
});

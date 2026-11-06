import { describe, expect, it } from "vitest";
import { FAVICON_MAX_BYTES, LOGO_MAX_BYTES, LOGO_MAX_HEIGHT, LOGO_MAX_WIDTH, validateThemeAsset } from "./asset-limits.js";

// STORY-097 scenario 9 — an oversize or wrong-dimension asset is refused with the limit named.
function png(w: number, h: number, pad = 0): Uint8Array {
  const b = Buffer.alloc(33 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
function ico(w: number, h: number): Uint8Array {
  const b = Buffer.alloc(22);
  b.writeUInt16LE(1, 2);
  b.writeUInt16LE(1, 4);
  b[6] = w === 256 ? 0 : w;
  b[7] = h === 256 ? 0 : h;
  return b;
}
function webpLossless(w: number, h: number): Uint8Array {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(22, 4);
  b.write("WEBP", 8, "ascii");
  b.write("VP8L", 12, "ascii");
  b.writeUInt32LE(10, 16);
  b[20] = 0x2f;
  const bits = (w - 1) | ((h - 1) << 14);
  b.writeUInt32LE(bits >>> 0, 21);
  return b;
}
function jpeg(w: number, h: number): Uint8Array {
  // SOI, APP0 (length 16), SOF0 (length 17: precision, height, width, 3 components), EOI
  const b = Buffer.alloc(2 + 18 + 19 + 2);
  b.writeUInt16BE(0xffd8, 0);
  b.writeUInt16BE(0xffe0, 2);
  b.writeUInt16BE(16, 4);
  b.write("JFIF", 6, "ascii");
  b.writeUInt16BE(0xffc0, 20);
  b.writeUInt16BE(17, 22);
  b[24] = 8;
  b.writeUInt16BE(h, 25);
  b.writeUInt16BE(w, 27);
  b[29] = 3;
  b.writeUInt16BE(0xffd9, b.length - 2);
  return b;
}
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 60"><rect width="1" height="1"/></svg>');

describe("STORY-097 · theme asset limits", () => {
  it("a PNG logo within 1200x400 and 1 MB is accepted unchanged", () => {
    const r = validateThemeAsset("logo_light", "image/png", png(1200, 400));
    expect(r).toMatchObject({ ok: true, contentType: "image/png", width: 1200, height: 400 });
  });
  it("scenario 9 · a logo one pixel too wide or too tall is refused, naming the limit", () => {
    const wide = validateThemeAsset("logo_light", "image/png", png(LOGO_MAX_WIDTH + 1, 100));
    expect(wide).toMatchObject({ ok: false, refused: [{ construct: "dimensions" }] });
    expect(JSON.stringify(wide)).toContain("1200");
    expect(validateThemeAsset("logo_dark", "image/png", png(100, LOGO_MAX_HEIGHT + 1))).toMatchObject({ ok: false });
  });
  it("owner decision 67 (n) · the logo limit is exactly 1 MiB", () => {
    expect(LOGO_MAX_BYTES).toBe(1_048_576);
  });
  it("scenario 9 · an oversize logo (1 MB + 1) and an oversize favicon (100 KB + 1) are refused, naming the size limit", () => {
    expect(validateThemeAsset("logo_light", "image/png", png(10, 10, LOGO_MAX_BYTES))).toMatchObject({ ok: false, refused: [{ construct: "size" }] });
    expect(validateThemeAsset("favicon", "image/png", png(32, 32, FAVICON_MAX_BYTES))).toMatchObject({ ok: false, refused: [{ construct: "size" }] });
    expect(validateThemeAsset("logo_light", "image/png", png(10, 10, LOGO_MAX_BYTES - 33))).toMatchObject({ ok: true });
  });
  it("a favicon must be square, PNG or ICO", () => {
    expect(validateThemeAsset("favicon", "image/png", png(32, 32))).toMatchObject({ ok: true });
    expect(validateThemeAsset("favicon", "image/png", png(32, 16))).toMatchObject({ ok: false, refused: [{ construct: "dimensions" }] });
    expect(validateThemeAsset("favicon", "image/x-icon", ico(32, 32))).toMatchObject({ ok: true, contentType: "image/x-icon" });
    expect(validateThemeAsset("favicon", "image/svg+xml", SVG)).toMatchObject({ ok: false, refused: [{ construct: "file type" }] });
  });
  it("WebP is read (lossless header) and an ICO logo is not a logo type", () => {
    expect(validateThemeAsset("logo_light", "image/webp", webpLossless(300, 100))).toMatchObject({ ok: true, width: 300, height: 100 });
    expect(validateThemeAsset("logo_light", "image/x-icon", ico(32, 32))).toMatchObject({ ok: false, refused: [{ construct: "file type" }] });
  });
  it("the type is decided by the bytes, not the declared header: a mismatch, an unknown file and empty bytes are refused", () => {
    expect(validateThemeAsset("logo_light", "image/webp", png(10, 10))).toMatchObject({ ok: false, refused: [{ construct: "file type" }] });
    expect(validateThemeAsset("logo_light", "image/png", new TextEncoder().encode("GIF89a"))).toMatchObject({ ok: false });
    expect(validateThemeAsset("logo_light", "image/png", new Uint8Array(0))).toMatchObject({ ok: false });
  });
  it("owner decision 67 (n) · a JPEG is accepted (dimensions read from its frame header) and a JPEG favicon is not a favicon type", () => {
    expect(validateThemeAsset("logo_light", "image/jpeg", jpeg(300, 100))).toMatchObject({ ok: true, contentType: "image/jpeg", width: 300, height: 100 });
    expect(validateThemeAsset("logo_light", "image/jpeg", jpeg(1201, 100))).toMatchObject({ ok: false, refused: [{ construct: "dimensions" }] });
    expect(validateThemeAsset("logo_light", "image/jpeg", png(10, 10))).toMatchObject({ ok: false, refused: [{ construct: "file type" }] });
    expect(validateThemeAsset("logo_light", "image/jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toMatchObject({ ok: false });
  });
  it("owner decision 67 (n) · an SVG is refused outright, for a logo and a favicon, naming the file type", () => {
    for (const slot of ["logo_light", "logo_dark", "favicon"] as const) {
      const r = validateThemeAsset(slot, "image/svg+xml", SVG);
      expect(r).toMatchObject({ ok: false, refused: [{ construct: "file type" }] });
      expect(JSON.stringify(r)).toContain("image/svg+xml");
    }
  });
});

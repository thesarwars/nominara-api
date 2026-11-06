
// STORY-097 · integrations-and-sharing.md §2 — what an agency may upload as a logo or favicon.
//   logo_light / logo_dark   PNG, JPEG or WebP, <= 1 MB, at most 1200x400   (owner decision 67 (n): SVG is refused, so there is nothing to sanitise)
//   favicon                  PNG or ICO, <= 100 KB, square
// The file's TYPE is decided by its bytes, never by the declared Content-Type: a declared type that disagrees with the bytes is a
// refusal.

export const LOGO_MAX_BYTES = 1024 * 1024;
export const FAVICON_MAX_BYTES = 100 * 1024;
export const LOGO_MAX_WIDTH = 1200;
export const LOGO_MAX_HEIGHT = 400;

export type ThemeAssetSlot = "logo_light" | "logo_dark" | "favicon";
export type ThemeAssetType = "image/png" | "image/jpeg" | "image/webp" | "image/x-icon";
export interface AssetRefusal {
  readonly construct: string;
  readonly message: string;
}
export type ThemeAssetResult =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly contentType: ThemeAssetType; readonly width: number; readonly height: number; }
  | { readonly ok: false; readonly refused: AssetRefusal[] };

const refuse = (construct: string, message: string): ThemeAssetResult => ({ ok: false, refused: [{ construct, message }] });
const ALLOWED: Readonly<Record<ThemeAssetSlot, readonly ThemeAssetType[]>> = {
  logo_light: ["image/png", "image/jpeg", "image/webp"],
  logo_dark: ["image/png", "image/jpeg", "image/webp"],
  favicon: ["image/png", "image/x-icon"],
};

function normaliseType(declared: string): string {
  const t = declared.split(";")[0]!.trim().toLowerCase();
  return t === "image/vnd.microsoft.icon" ? "image/x-icon" : t;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const startsWith = (b: Uint8Array, sig: number[]): boolean => b.length >= sig.length && sig.every((v, i) => b[i] === v);
const ascii = (b: Uint8Array, at: number, len: number): string => String.fromCharCode(...b.subarray(at, at + len));

function dimensionsOf(type: ThemeAssetType, b: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (type === "image/png") {
    if (!startsWith(b, PNG_SIG) || b.length < 24 || ascii(b, 12, 4) !== "IHDR") return null;
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (type === "image/jpeg") {
    if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
    let at = 2;
    while (at + 4 <= b.length) {
      if (b[at] !== 0xff) return null;
      const marker = b[at + 1]!;
      if (marker === 0xff) {
        at += 1;
        continue;
      }
      // Start-of-frame markers (SOF0-SOF15 except DHT 0xC4, JPG 0xC8, DAC 0xCC) carry the size: precision(1) height(2) width(2).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (at + 9 > b.length) return null;
        return { width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
      }
      if (marker === 0xd9 || marker === 0xda) return null;
      at += 2 + view.getUint16(at + 2);
    }
    return null;
  }
  if (type === "image/webp") {
    if (b.length < 30 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return null;
    const kind = ascii(b, 12, 4);
    if (kind === "VP8X") return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
    if (kind === "VP8L") {
      if (b[20] !== 0x2f) return null;
      const bits = view.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (kind === "VP8 ") {
      if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    }
    return null;
  }
  if (type === "image/x-icon") {
    if (b.length < 22 || !startsWith(b, [0, 0, 1, 0])) return null;
    const count = view.getUint16(4, true);
    if (count === 0 || b.length < 6 + count * 16) return null;
    let width = 0;
    let height = 0;
    for (let i = 0; i < count; i += 1) {
      width = Math.max(width, b[6 + i * 16]! || 256);
      height = Math.max(height, b[7 + i * 16]! || 256);
    }
    return { width, height };
  }
  return null;
}

export function validateThemeAsset(slot: ThemeAssetSlot, declaredType: string, bytes: Uint8Array): ThemeAssetResult {
  const maxBytes = slot === "favicon" ? FAVICON_MAX_BYTES : LOGO_MAX_BYTES;
  const declared = normaliseType(declaredType);
  if (!(ALLOWED[slot] as readonly string[]).includes(declared)) {
    return refuse("file type", declaredType + " is not allowed for " + slot + " (allowed: " + ALLOWED[slot].join(", ") + ")");
  }
  const type = declared as ThemeAssetType;
  if (bytes.length === 0) return refuse("file type", "the file is empty");
  if (bytes.length > maxBytes) return refuse("size", "the file is " + String(bytes.length) + " bytes; the limit for " + slot + " is " + String(maxBytes) + " bytes");

  const dims = dimensionsOf(type, bytes);
  if (dims === null) return refuse("file type", "the file's bytes are not a valid " + type + " image");
  return limitDimensions(slot, { ok: true, bytes, contentType: type, width: dims.width, height: dims.height });
}

function limitDimensions(slot: ThemeAssetSlot, ok: Extract<ThemeAssetResult, { ok: true }>): ThemeAssetResult {
  const { width, height } = ok;
  if (slot === "favicon") {
    return width === height ? ok : refuse("dimensions", "a favicon must be square; this one is " + String(width) + "x" + String(height));
  }
  if (width > LOGO_MAX_WIDTH || height > LOGO_MAX_HEIGHT) {
    return refuse("dimensions", "a logo is at most " + String(LOGO_MAX_WIDTH) + "x" + String(LOGO_MAX_HEIGHT) + "; this one is " + String(width) + "x" + String(height));
  }
  return ok;
}

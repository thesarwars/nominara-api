import { PORTAL_LOGO_MAX_BYTES } from "../../../contracts/portal/index.js";
import { validateThemeAsset, type ThemeAssetType } from "./asset-limits.js";

// Owner decision 71 (a) — the portal serves the agency's logo as an enveloped `data:` URL (an anonymous viewer has no route to the
// stored file, so a URL would be a broken image). Three rules keep that safe:
//   1. the bytes are re-checked here with the SAME validator the upload used (type decided by the bytes, dimensions, no SVG), so an
//      object that was swapped or corrupted in storage after upload is not served;
//   2. the envelope is built by us from a type WE decided, never copied from a stored or declared content type;
//   3. at most PORTAL_LOGO_MAX_BYTES (256 KB). Checked BEFORE the bytes are decoded or encoded, so an oversize object costs nothing.
// The contract's `portalLogoDataUrlSchema` is the second gate: whatever this returns still has to pass it on the way out.

export type PortalLogoResult =
  | { readonly ok: true; readonly dataUrl: string }
  | { readonly ok: false; readonly reason: "too_large" | "invalid" };

const TYPES: readonly ThemeAssetType[] = ["image/png", "image/jpeg", "image/webp"];

export function portalLogoDataUrl(bytes: Uint8Array): PortalLogoResult {
  if (bytes.length > PORTAL_LOGO_MAX_BYTES) return { ok: false, reason: "too_large" };
  for (const type of TYPES) {
    const checked = validateThemeAsset("logo_light", type, bytes);
    if (checked.ok) return { ok: true, dataUrl: `data:${checked.contentType};base64,${Buffer.from(bytes).toString("base64")}` };
  }
  return { ok: false, reason: "invalid" };
}

import { describe, expect, it } from "vitest";
import { PLATFORM_DEFAULT_COLORS } from "../../../src/lib/theme/contrast.js";
import { exportPaletteFrom } from "../../../src/lib/theme/export-palette.js";

// NEW-E-100b — the stored theme becomes the export palette in ONE place
// (STORY-097 AC4: the theme row is the only source of branding).

const stored = { color_primary: "#112233", color_accent: "#445566", color_bg: "#778899", color_fg: "#aabbcc", hide_nominara_brand: false };

describe("NEW-E-100b · exportPaletteFrom", () => {
  it("NEW-E-100b — uses the stored colours and keeps the brand line unless brand removal is on", () => {
    expect(exportPaletteFrom(stored)).toEqual({ primary: "#112233", accent: "#445566", background: "#778899", foreground: "#aabbcc", showBrandLine: true });
    expect(exportPaletteFrom({ ...stored, hide_nominara_brand: true }).showBrandLine).toBe(false);
  });

  it("NEW-E-100b — no stored theme is the platform default, with the brand line shown", () => {
    expect(exportPaletteFrom(undefined)).toEqual({
      primary: PLATFORM_DEFAULT_COLORS.color_primary,
      accent: PLATFORM_DEFAULT_COLORS.color_accent,
      background: PLATFORM_DEFAULT_COLORS.color_bg,
      foreground: PLATFORM_DEFAULT_COLORS.color_fg,
      showBrandLine: true,
    });
  });

  it("NEW-E-100b — a null colour (D6: inherit) or a malformed one falls back to the platform default, per colour", () => {
    const palette = exportPaletteFrom({ ...stored, color_primary: null, color_accent: "red", color_bg: "#12345", color_fg: "#AABBCC" });
    expect(palette.primary).toBe(PLATFORM_DEFAULT_COLORS.color_primary);
    expect(palette.accent).toBe(PLATFORM_DEFAULT_COLORS.color_accent);
    expect(palette.background).toBe(PLATFORM_DEFAULT_COLORS.color_bg);
    expect(palette.foreground).toBe("#AABBCC");
  });

  it("NEW-E-100b — the palette has no footer, stylesheet or section field to carry", () => {
    expect(Object.keys(exportPaletteFrom(stored)).sort()).toEqual(["accent", "background", "foreground", "primary", "showBrandLine"]);
  });
});

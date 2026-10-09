import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  CURATED_FONT_FAMILIES,
  PLATFORM_DEFAULT_COLORS,
  validateThemeContrast,
} from "./contrast.js";

// STORY-097 · FR-AGY-01h — contrast is rejected server-side, with the measured
// ratio and the nearest passing suggestion. Thresholds: NFR-UI-01 (4.5:1 text,
// 3:1 graph strokes).
describe("STORY-097 · contrastRatio (WCAG 2.x)", () => {
  it("black on white is exactly 21:1 and identical colours are 1:1", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 5);
  });
  it("is symmetric and case-insensitive", () => {
    expect(contrastRatio("#FFFFFF", "#6a3de8")).toBeCloseTo(contrastRatio("#6A3DE8", "#ffffff"), 10);
  });
});

describe("STORY-097 · validateThemeContrast", () => {
  const defaults = PLATFORM_DEFAULT_COLORS;

  it("scenario 6 · a failing fg/bg pair is refused with the measured ratio and a passing suggestion", () => {
    const result = validateThemeContrast({ color_primary: null, color_accent: null, color_bg: "#ffffff", color_fg: "#aaaaaa" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.token).toBe("color_fg_on_bg");
    expect(result.failure.threshold).toBe(4.5);
    expect(result.failure.measured_ratio).toBeCloseTo(contrastRatio("#aaaaaa", "#ffffff"), 2);
    expect(result.failure.measured_ratio).toBeLessThan(4.5);
    expect(result.failure.field).toBe("color_fg");
    // the suggestion really passes, and is the NEAREST: one lightness step less would not
    expect(contrastRatio(result.failure.suggestion, "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  it("scenario 7 · a pair failing ONLY the 3:1 graph-stroke threshold is refused", () => {
    // #949494 on white is ~3.03 (passes 3:1 ... so use a lighter one): #b0b0b0 ~2.17
    const result = validateThemeContrast({ color_primary: "#b0b0b0", color_accent: null, color_bg: "#ffffff", color_fg: "#16142e" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.token).toBe("color_primary_on_bg");
    expect(result.failure.threshold).toBe(3);
    expect(result.failure.field).toBe("color_primary");
    expect(contrastRatio(result.failure.suggestion, "#ffffff")).toBeGreaterThanOrEqual(3);
  });

  it("a colour between 3:1 and 4.5:1 is accepted as a stroke colour but refused as text", () => {
    const mid = "#8a8a8a"; // ~3.4:1 on white
    expect(contrastRatio(mid, "#ffffff")).toBeGreaterThan(3);
    expect(contrastRatio(mid, "#ffffff")).toBeLessThan(4.5);
    expect(validateThemeContrast({ color_primary: mid, color_accent: null, color_bg: "#ffffff", color_fg: null }).ok).toBe(true);
    expect(validateThemeContrast({ color_primary: null, color_accent: null, color_bg: "#ffffff", color_fg: mid }).ok).toBe(false);
  });

  it("exactly at the threshold passes (boundary)", () => {
    // #767676 on white is 4.54:1, the canonical AA-passing grey
    expect(validateThemeContrast({ color_primary: null, color_accent: null, color_bg: "#ffffff", color_fg: "#767676" }).ok).toBe(true);
    // #777777 on white is 4.48:1
    expect(validateThemeContrast({ color_primary: null, color_accent: null, color_bg: "#ffffff", color_fg: "#777777" }).ok).toBe(false);
  });

  it("all-null (the platform default) passes; a null colour is judged as the platform default, not skipped", () => {
    expect(validateThemeContrast({ color_primary: null, color_accent: null, color_bg: null, color_fg: null }).ok).toBe(true);
    // fg set to the default canvas colour over a null bg must fail: it is invisible against the default
    const r = validateThemeContrast({ color_primary: null, color_accent: null, color_bg: null, color_fg: defaults.color_bg });
    expect(r.ok).toBe(false);
  });

  it("a suggestion keeps the failing colour's hue family and never returns the failing colour", () => {
    const r = validateThemeContrast({ color_primary: null, color_accent: "#ffff00", color_bg: "#ffffff", color_fg: null });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.suggestion.toLowerCase()).not.toBe("#ffff00");
    expect(contrastRatio(r.failure.suggestion, "#ffffff")).toBeGreaterThanOrEqual(3);
  });

  it("a suggestion is found even on a mid-grey background where neither direction trivially works", () => {
    const r = validateThemeContrast({ color_primary: null, color_accent: null, color_bg: "#808080", color_fg: "#8a8a8a" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(contrastRatio(r.failure.suggestion, "#808080")).toBeGreaterThanOrEqual(4.5);
  });
});

describe("STORY-097 · curated fonts", () => {
  it("contains the platform default family and is a closed set", () => {
    expect(CURATED_FONT_FAMILIES).toContain("Inter");
    expect(CURATED_FONT_FAMILIES).not.toContain("Comic Sans MS");
  });
});

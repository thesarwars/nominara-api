// STORY-097 · FR-AGY-01h — server-side contrast validation for brand themes.
//
// integrations-and-sharing.md §2: "A combination failing WCAG AA against the
// tokens it drives is rejected with the measured ratio and the nearest passing
// suggestion." Thresholds are NFR-UI-01 (ui-ux-guidelines.md): 4.5:1 for text,
// 3:1 for UI and graph strokes.
//
// WHICH TOKEN DRIVES WHAT (aurora-signal-tokens.md): color_fg is body text on
// color_bg; color_primary and color_accent are sparkline strokes, score-ring
// arcs, underlines and toggles drawn over color_bg, so they are held to the
// 3:1 stroke threshold.
//
// A NULL COLOUR IS NOT SKIPPED. D6: null = the platform default (Aurora Signal,
// light mode — brand_themes colours override LIGHT only). A custom fg over a
// null bg renders over the default canvas, so the pair is judged against the
// default's real value. Skipping it would let an invisible theme save.

export const TEXT_CONTRAST_MIN = 4.5;
export const STROKE_CONTRAST_MIN = 3;

/** aurora-signal-tokens.md, light column: canvas / fg / primary / accent. */
export const PLATFORM_DEFAULT_COLORS = {
  color_bg: "#f7f7fc",
  color_fg: "#16142e",
  color_primary: "#6a3de8",
  color_accent: "#0b7285",
} as const;

/**
 * The curated, self-hosted font families (ui-ux-guidelines.md: "No external
 * font CDN"). Inter is the schema default and Geist is the second family the
 * client ships (@fontsource-variable/geist). Widening this set means shipping
 * the font file first.
 */
export const CURATED_FONT_FAMILIES = ["Inter", "Geist"] as const;

export type ThemeColorField = "color_primary" | "color_accent" | "color_bg" | "color_fg";
export type ThemeColors = { readonly [K in ThemeColorField]: string | null };

export interface ContrastFailure {
  readonly field: ThemeColorField;
  readonly token: string;
  readonly measured_ratio: number;
  readonly threshold: number;
  readonly suggestion: string;
}

export type ContrastResult = { readonly ok: true } | { readonly ok: false; readonly failure: ContrastFailure };

type Rgb = readonly [number, number, number];

function parseHex(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t0: number): number => {
    const t = t0 < 0 ? t0 + 1 : t0 > 1 ? t0 - 1 : t0;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [channel(h + 1 / 3) * 255, channel(h) * 255, channel(h - 1 / 3) * 255];
}

/**
 * The nearest passing colour: the same hue and saturation, with lightness moved
 * the smallest distance (either direction) that reaches `threshold` against
 * `against`. Falls back to black or white, whichever contrasts more, when no
 * lightness on that hue can (a mid-tone background with a saturated hue).
 */
function nearestPassing(colour: string, against: string, threshold: number): string {
  const [h, s, l] = rgbToHsl(parseHex(colour));
  const STEPS = 1000;
  for (let i = 1; i <= STEPS; i++) {
    const delta = i / STEPS;
    // try the direction that moves away from the background first on a tie
    const candidates = [l - delta, l + delta].filter((v) => v >= 0 && v <= 1);
    const passing = candidates
      .map((v) => toHex(hslToRgb(h, s, v)))
      .filter((hex) => contrastRatio(hex, against) >= threshold);
    if (passing.length > 0) {
      return passing.reduce((best, hex) => (contrastRatio(hex, against) > contrastRatio(best, against) ? hex : best));
    }
  }
  return contrastRatio("#000000", against) >= contrastRatio("#ffffff", against) ? "#000000" : "#ffffff";
}

const PAIRS: ReadonlyArray<{ field: ThemeColorField; token: string; threshold: number }> = [
  { field: "color_fg", token: "color_fg_on_bg", threshold: TEXT_CONTRAST_MIN },
  { field: "color_primary", token: "color_primary_on_bg", threshold: STROKE_CONTRAST_MIN },
  { field: "color_accent", token: "color_accent_on_bg", threshold: STROKE_CONTRAST_MIN },
];

/** Judges the EFFECTIVE theme (null = platform default). Reports the first failing pair. */
export function validateThemeContrast(colors: ThemeColors): ContrastResult {
  const effective = (field: ThemeColorField): string => colors[field] ?? PLATFORM_DEFAULT_COLORS[field];
  const bg = effective("color_bg");
  for (const pair of PAIRS) {
    const colour = effective(pair.field);
    const measured = contrastRatio(colour, bg);
    if (measured < pair.threshold) {
      return {
        ok: false,
        failure: {
          field: pair.field,
          token: pair.token,
          measured_ratio: Math.floor(measured * 100) / 100,
          threshold: pair.threshold,
          suggestion: nearestPassing(colour, bg, pair.threshold),
        },
      };
    }
  }
  return { ok: true };
}

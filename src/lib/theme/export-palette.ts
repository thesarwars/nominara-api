import { PLATFORM_DEFAULT_COLORS } from "./contrast.js";

// NEW-E-100b — the one place a stored theme becomes what a document renderer
// draws with. STORY-097 AC4: the theme row is the only source of branding, and
// exports take colours and brand-removal from it. This is a pure function over
// the theme's own values (so it lives with the other theme helpers); the report
// renderers receive only the neutral `ExportPalette` and never name a stored
// theme field, so they cannot grow a second branding configuration.
//
// There is no footer, stylesheet or section field here, by design: nothing a
// theme can carry reaches the methodology footer (NFR-AGY-05).

export interface ExportPalette {
  readonly primary: string;
  readonly accent: string;
  readonly background: string;
  readonly foreground: string;
  /** False once the workspace has removed Nominara branding. Never affects the methodology footer. */
  readonly showBrandLine: boolean;
}

export interface StoredThemeValues {
  readonly color_primary: string | null;
  readonly color_accent: string | null;
  readonly color_bg: string | null;
  readonly color_fg: string | null;
  readonly hide_nominara_brand: boolean;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** A null (D6: inherit the platform default) or malformed stored colour falls back to the platform default. */
function colour(value: string | null, fallback: string): string {
  return value !== null && HEX.test(value) ? value : fallback;
}

/**
 * `undefined` = the workspace has no stored theme: the platform default.
 *
 * `brandRemovalGranted` is whether the workspace holds `whitelabel.remove_branding` NOW. The stored
 * `hide_nominara_brand` was validated when it was saved; a later downgrade leaves it stored, and a render
 * must not honour what the plan no longer grants (STORY-097 scenario 4/5, CP1 audit). Required, so no
 * caller can forget to say.
 */
export function exportPaletteFrom(theme: StoredThemeValues | undefined, brandRemovalGranted: boolean): ExportPalette {
  return {
    primary: colour(theme?.color_primary ?? null, PLATFORM_DEFAULT_COLORS.color_primary),
    accent: colour(theme?.color_accent ?? null, PLATFORM_DEFAULT_COLORS.color_accent),
    background: colour(theme?.color_bg ?? null, PLATFORM_DEFAULT_COLORS.color_bg),
    foreground: colour(theme?.color_fg ?? null, PLATFORM_DEFAULT_COLORS.color_fg),
    showBrandLine: theme === undefined ? true : !(theme.hide_nominara_brand && brandRemovalGranted),
  };
}

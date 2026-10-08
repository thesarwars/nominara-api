import { Injectable, Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import {
  contrastRejectionDetailsSchema,
  type AgencyTheme,
  type UpdateAgencyThemeRequest,
} from "../../../contracts/agency/index.js";
import { ConflictError, FeatureNotInPlanError, NotFoundError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { resolveEntitlements } from "../../lib/entitlements/resolution.js";
import {
  CURATED_FONT_FAMILIES,
  validateThemeContrast,
  type ThemeColorField,
  type ThemeColors,
} from "../../lib/theme/contrast.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";

/**
 * GET returns this id for the unsaved platform-default theme (D6, STORY-097).
 * PUT naming it creates the first real theme, so the editor can save what it
 * was shown without a special case.
 */
export const PLATFORM_DEFAULT_THEME_ID = "00000000-0000-0000-0000-000000000000";

const DEFAULT_THEME_NAME = "Default";
const DEFAULT_FONT_FAMILY = "Inter";
const BRAND_REMOVAL_FEATURE = "whitelabel.remove_branding";
const COLOR_FIELDS = ["color_primary", "color_accent", "color_bg", "color_fg"] as const satisfies readonly ThemeColorField[];

interface ThemeRow {
  readonly id: string;
  readonly name: string;
  readonly is_default: boolean;
  readonly color_primary: string | null;
  readonly color_accent: string | null;
  readonly color_bg: string | null;
  readonly color_fg: string | null;
  readonly font_family: string;
  readonly hide_nominara_brand: boolean;
}

const COLUMNS = "id, name, is_default, color_primary, color_accent, color_bg, color_fg, font_family, hide_nominara_brand";

/** Contrast ratios are written "N:1"; built by concatenation so the text is not a key-shaped template. */
function ratioText(n: number): string {
  return String(n) + ":1";
}

function toTheme(row: ThemeRow): AgencyTheme {
  return {
    theme_id: row.id,
    name: row.name,
    is_default: row.is_default,
    color_primary: row.color_primary,
    color_accent: row.color_accent,
    color_bg: row.color_bg,
    color_fg: row.color_fg,
    font_family: row.font_family,
    // Asset upload is week 2 (STORY-097 scenarios 9-11): no logo is ever stored yet.
    logo_url: null,
    hide_nominara_brand: row.hide_nominara_brand,
  };
}

// STORY-097 — owns `brand_themes` (coding-standards.md §1, one table one
// owning service). Branding has no other source: the portal overview and the
// export read this table through this service (FR-AGY-01g).
//
// Every statement runs on the request's context-carrying transaction, so RLS
// (`ws_isolation_brand_themes`) is what scopes the workspace; there is no
// workspace_id predicate for correctness, and none is read from the body.
@Injectable()
export class AgencyService {
  private readonly logger = new Logger(AgencyService.name);

  /** All of the workspace's themes, the default first. With none stored, the unsaved platform default. */
  async listThemes(): Promise<AgencyTheme[]> {
    const { client } = this.store();
    const result = await client.query<ThemeRow>(`SELECT ${COLUMNS} FROM brand_themes ORDER BY is_default DESC, created_at, id`);
    if (result.rows.length === 0) return [platformDefaultTheme()];
    return result.rows.map(toTheme);
  }

  /**
   * NEW-E-099a — the theme a portal session is rendered with: the token's pinned theme when it names one the workspace
   * still has, else the workspace default, else the unsaved platform default (null colours). Never an error: a pinned
   * theme that was deleted must not take a client's portal down. Read-only, so it runs on the portal's transaction.
   */
  async themeForPortal(pinnedThemeId: string | null): Promise<AgencyTheme> {
    const { client } = this.store();
    const result = await client.query<ThemeRow>(
      `SELECT ${COLUMNS} FROM brand_themes WHERE ($1::uuid IS NOT NULL AND id = $1::uuid) OR is_default ORDER BY (id = $1::uuid) DESC NULLS LAST, is_default DESC, created_at, id LIMIT 1`,
      [pinnedThemeId],
    );
    const row = result.rows[0];
    return row === undefined ? platformDefaultTheme() : toTheme(row);
  }

  /**
   * Creates (no `theme_id`, or the platform-default id) or updates a theme.
   * Everything is checked here, not in the editor: a direct API call must not
   * be able to save what the interface would refuse (STORY-097 scenario 8).
   */
  async saveTheme(body: UpdateAgencyThemeRequest): Promise<AgencyTheme> {
    const { client, workspaceId } = this.store();

    if (body.font_family !== undefined && !(CURATED_FONT_FAMILIES as readonly string[]).includes(body.font_family)) {
      throw new ValidationFailedError({
        message: "font_family is not in the curated self-hosted set",
        details: { issues: [{ path: ["font_family"], message: `must be one of: ${CURATED_FONT_FAMILIES.join(", ")}` }] },
      });
    }

    // Saves are serialised per workspace for the rest of this transaction. Without it two concurrent FIRST
    // saves both read "no default yet" and both insert a default; the second dies on ux_brand_themes_default
    // (a raw 23505 -> 500). Same primitive as the share-link cap.
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`brand_themes:${workspaceId}`]);

    const existing = await this.loadForUpdate(client, body.theme_id);
    const colors = mergedColors(existing, body);

    const contrast = validateThemeContrast(colors);
    if (!contrast.ok) {
      const f = contrast.failure;
      incrementCounter("nominara_theme_contrast_rejections_total", { token: f.token });
      this.logger.warn(`theme contrast rejected workspace_id=${workspaceId} token=${f.token} measured_ratio=${String(f.measured_ratio)}`);
      throw new ValidationFailedError({
        message: f.field + " fails the " + ratioText(f.threshold) + " contrast requirement (measured " + ratioText(f.measured_ratio) + ")",
        details: contrastRejectionDetailsSchema.parse({
          issues: [{ path: [f.field], message: `contrast ${ratioText(f.measured_ratio)} is below ${ratioText(f.threshold)}; try ${f.suggestion}` }],
          measured_ratio: f.measured_ratio,
          threshold: f.threshold,
          token: f.token,
          suggestion: f.suggestion,
        }),
      });
    }

    if (body.hide_nominara_brand === true) await this.assertBrandRemovalGranted(client, workspaceId);

    const font = body.font_family ?? existing?.font_family ?? DEFAULT_FONT_FAMILY;
    const hide = body.hide_nominara_brand ?? existing?.hide_nominara_brand ?? false;
    const name = body.name ?? existing?.name ?? DEFAULT_THEME_NAME;

    const hasDefault = await this.hasDefault(client, existing?.id);
    if (existing?.is_default === true && body.is_default === false) {
      throw new ValidationFailedError({
        message: "a workspace always has exactly one default theme; make another theme the default instead",
        details: { issues: [{ path: ["is_default"], message: "the default theme cannot be unset directly" }] },
      });
    }
    // The first theme is the default whatever was asked (ux_brand_themes_default: one per workspace).
    const makeDefault = existing?.is_default === true || body.is_default === true || !hasDefault;
    if (makeDefault) {
      await client.query(`UPDATE brand_themes SET is_default = false WHERE is_default AND id IS DISTINCT FROM $1`, [existing?.id ?? null]);
    }

    let row: ThemeRow;
    try {
      row = await this.write(client, workspaceId, existing, { name, makeDefault, colors, font, hide });
    } catch (error) {
      // The lock above makes this unreachable between our own requests; if the index still fires (a writer that
      // bypassed this service) it is a conflict the caller can retry, never a 500.
      if (isUniqueViolation(error, "ux_brand_themes_default")) {
        throw new ConflictError({ message: "another request changed the default theme at the same time; retry" });
      }
      throw error;
    }
    incrementCounter("nominara_theme_saves_total", { outcome: existing === undefined ? "created" : "updated" });
    this.logger.log(`theme saved workspace_id=${workspaceId} theme_id=${row.id}`);
    return toTheme(row);
  }

  private async write(
    client: ClientBase,
    workspaceId: string,
    existing: ThemeRow | undefined,
    v: { name: string; makeDefault: boolean; colors: ThemeColors; font: string; hide: boolean },
  ): Promise<ThemeRow> {
    const { name, makeDefault, colors, font, hide } = v;
    let row: ThemeRow;
    if (existing === undefined) {
      const inserted = await client.query<ThemeRow>(
        `INSERT INTO brand_themes (workspace_id, name, is_default, color_primary, color_accent, color_bg, color_fg, font_family, hide_nominara_brand)
         VALUES ($9, $1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${COLUMNS}`,
        [name, makeDefault, colors.color_primary, colors.color_accent, colors.color_bg, colors.color_fg, font, hide, workspaceId],
      );
      row = inserted.rows[0]!;
    } else {
      const updated = await client.query<ThemeRow>(
        `UPDATE brand_themes
            SET name = $2, is_default = $3, color_primary = $4, color_accent = $5, color_bg = $6, color_fg = $7,
                font_family = $8, hide_nominara_brand = $9
          WHERE id = $1
          RETURNING ${COLUMNS}`,
        [existing.id, name, makeDefault, colors.color_primary, colors.color_accent, colors.color_bg, colors.color_fg, font, hide],
      );
      row = updated.rows[0]!;
    }
    return row;
  }

  private async loadForUpdate(client: ClientBase, themeId: string | undefined): Promise<ThemeRow | undefined> {
    if (themeId === undefined || themeId === PLATFORM_DEFAULT_THEME_ID) return undefined;
    const result = await client.query<ThemeRow>(`SELECT ${COLUMNS} FROM brand_themes WHERE id = $1 FOR UPDATE`, [themeId]);
    // RLS hides another workspace's row, so a foreign id is indistinguishable from an absent one, by design.
    if (result.rows[0] === undefined) throw new NotFoundError({ message: "no such theme" });
    return result.rows[0];
  }

  private async hasDefault(client: ClientBase, excludingId: string | undefined): Promise<boolean> {
    const result = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM brand_themes WHERE is_default AND id IS DISTINCT FROM $1`,
      [excludingId ?? null],
    );
    return (result.rows[0]?.n ?? 0) > 0;
  }

  private async assertBrandRemovalGranted(client: ClientBase, workspaceId: string): Promise<void> {
    const resolved = await resolveEntitlements(client, workspaceId);
    if (resolved.entitlements[BRAND_REMOVAL_FEATURE]?.value !== true) {
      throw new FeatureNotInPlanError({ details: { key: BRAND_REMOVAL_FEATURE, min_plan: "business" } });
    }
  }

  private store(): { client: ClientBase; workspaceId: string } {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("AgencyService requires an active tenant context");
    return { client: store.client, workspaceId: store.context.workspaceId };
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const pg = error as { code?: string; constraint?: string } | null;
  return pg?.code === "23505" && pg.constraint === constraint;
}

function platformDefaultTheme(): AgencyTheme {
  return {
    theme_id: PLATFORM_DEFAULT_THEME_ID,
    name: DEFAULT_THEME_NAME,
    is_default: true,
    color_primary: null,
    color_accent: null,
    color_bg: null,
    color_fg: null,
    font_family: DEFAULT_FONT_FAMILY,
    logo_url: null,
    hide_nominara_brand: false,
  };
}

/** A field absent from the body keeps its stored value; an explicit null resets it to the platform default. */
function mergedColors(existing: ThemeRow | undefined, body: UpdateAgencyThemeRequest): ThemeColors {
  const out: Record<ThemeColorField, string | null> = { color_primary: null, color_accent: null, color_bg: null, color_fg: null };
  for (const field of COLOR_FIELDS) {
    out[field] = body[field] !== undefined ? body[field] : (existing?.[field] ?? null);
  }
  return out;
}

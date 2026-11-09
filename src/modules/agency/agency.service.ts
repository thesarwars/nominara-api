import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ClientBase, Pool } from "pg";
import {
  contrastRejectionDetailsSchema,
  styleRefusalDetailsSchema,
  type AgencyTheme,
  type ThemeAssetSlotName,
  type SaveAgencyThemeResponse,
  type AgencyThemeAdmin,
  type AgencyThemeListQuery,
  type UpdateAgencyThemeRequest,
} from "../../../contracts/agency/index.js";
import { API_VERSION_PREFIX } from "../../api/configure-app.js";
import { ConflictError, FeatureNotInPlanError, NotFoundError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { decodeCursor } from "../../api/pagination/cursor.js";
import { pageFrom, Page } from "../../api/pagination/page.js";
import { invalidCursor, MICROS_FORMAT } from "../../api/pagination/timestamp-id-cursor.js";
import { resolveEntitlements } from "../../lib/entitlements/resolution.js";
import {
  CURATED_FONT_FAMILIES,
  validateThemeContrast,
  type ThemeColorField,
  type ThemeColors,
} from "../../lib/theme/contrast.js";
import { sanitiseCustomCss } from "../../lib/theme/custom-css.js";
import { sanitiseEmailFooter } from "../../lib/theme/email-footer.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { currentTenantStore, withTenantContext, type TenantContext } from "../../tenancy/tenant-context.js";

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
  readonly email_from_name: string | null;
  readonly email_reply_to: string | null;
  readonly custom_css: string | null;
  readonly email_footer_html: string | null;
  readonly logo_light_key: string | null;
}

const COLUMNS =
  "id, name, is_default, color_primary, color_accent, color_bg, color_fg, font_family, hide_nominara_brand, email_from_name, email_reply_to, custom_css, email_footer_html, logo_light_key";

const ISO_MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function themeCursorKeyOf(cursor: string): [number, string, string] {
  const [isDefault, createdAt, id] = decodeCursor(cursor, "agency.themes", 3);
  if ((isDefault !== 0 && isDefault !== 1) || typeof createdAt !== "string" || !ISO_MICROS.test(createdAt) || typeof id !== "string" || !UUID.test(id)) {
    throw invalidCursor();
  }
  return [isDefault, createdAt, id];
}

/** Contrast ratios are written "N:1"; built by concatenation so the text is not a key-shaped template. */
function ratioText(n: number): string {
  return String(n) + ":1";
}

/** The platform-origin path a stored asset is fetched from. Never the object key, never a bucket host. */
export function themeAssetPath(themeId: string, slot: ThemeAssetSlotName): string {
  return "/" + API_VERSION_PREFIX + "/themes/" + themeId + "/assets/" + slot;
}

function toTheme(row: ThemeRow): AgencyThemeAdmin {
  return {
    theme_id: row.id,
    name: row.name,
    is_default: row.is_default,
    color_primary: row.color_primary,
    color_accent: row.color_accent,
    color_bg: row.color_bg,
    color_fg: row.color_fg,
    font_family: row.font_family,
    // A path on the platform's own origin (scenario 11); the route behind it redirects to a short presign. null = no logo uploaded.
    logo_url: row.logo_light_key === null ? null : themeAssetPath(row.id, "logo_light"),
    hide_nominara_brand: row.hide_nominara_brand,
    email_from_name: row.email_from_name,
    email_reply_to: row.email_reply_to,
    custom_css: row.custom_css,
    email_footer_html: row.email_footer_html,
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

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** slot -> brand_themes column. A closed switch: the column name in the SQL never comes from input. */
  private assetColumn(slot: ThemeAssetSlotName): string {
    switch (slot) {
      case "logo_light":
        return "logo_light_key";
      case "logo_dark":
        return "logo_dark_key";
      case "favicon":
        return "favicon_key";
    }
  }

  /** The stored object key for one slot of a theme in the caller's workspace (null = none uploaded). 404 for an unknown or foreign theme. */
  async assetKey(themeId: string, slot: ThemeAssetSlotName): Promise<string | null> {
    const { client } = this.store();
    const result = await client.query<{ key: string | null }>(`SELECT ${this.assetColumn(slot)} AS key FROM brand_themes WHERE id = $1`, [themeId]);
    if (result.rows[0] === undefined) throw new NotFoundError({ message: "no such theme" });
    return result.rows[0].key;
  }

  /**
   * Points a slot at a freshly stored object, in its OWN short tenant transaction: the caller has already written the object, and no
   * request transaction is held across that storage call (KAD-06). Returns the previous key for the caller to delete, or null.
   */
  async recordAssetKey(
    context: TenantContext,
    themeId: string,
    slot: ThemeAssetSlotName,
    key: string,
    /** Runs in the SAME transaction once the key is recorded (the success audit row), so the row and the outcome commit or roll back together. */
    within?: (tx: ClientBase) => Promise<void>,
  ): Promise<string | null> {
    const client = await this.pool.connect();
    try {
      return await withTenantContext(client, context, async (tx) => {
        const before = await tx.query<{ key: string | null }>(`SELECT ${this.assetColumn(slot)} AS key FROM brand_themes WHERE id = $1 FOR UPDATE`, [themeId]);
        if (before.rows[0] === undefined) throw new NotFoundError({ message: "no such theme" });
        await tx.query(`UPDATE brand_themes SET ${this.assetColumn(slot)} = $2, updated_at = now() WHERE id = $1`, [themeId, key]);
        await within?.(tx);
        return before.rows[0].key;
      });
    } finally {
      client.release();
    }
  }

  /** All of the workspace's themes, the default first. With none stored, the unsaved platform default. */
  /**
   * NEW-E-7 checkpoint-6 — keyset page ordered (is_default DESC, created_at, id). The cursor key is
   * [is_default as 1/0, created_at at microsecond precision, id]; the default is first, so the mixed direction is
   * an explicit two-branch predicate rather than a row comparison. A workspace with no stored theme still gets the
   * unsaved platform default as the one item of its first page.
   */
  async listThemes(query: AgencyThemeListQuery): Promise<Page<AgencyThemeAdmin>> {
    const { client } = this.store();
    const after = query.cursor === undefined ? undefined : themeCursorKeyOf(query.cursor);
    const result = await client.query<ThemeRow & { created_at_key: string }>(
      `SELECT ${COLUMNS}, to_char(created_at AT TIME ZONE 'UTC', ${MICROS_FORMAT}) AS created_at_key
         FROM brand_themes
        WHERE $1::int IS NULL
           OR is_default::int < $1::int
           OR (is_default::int = $1::int AND (created_at, id) > ($2::timestamptz, $3::uuid))
        ORDER BY is_default DESC, created_at, id
        LIMIT $4`,
      [after?.[0] ?? null, after?.[1] ?? null, after?.[2] ?? null, query.limit + 1],
    );
    if (result.rows.length === 0 && after === undefined) return new Page([platformDefaultTheme()], { cursor_next: null, has_more: false, limit: query.limit });
    return pageFrom(result.rows, query.limit, "agency.themes", toTheme, (row) => [row.is_default ? 1 : 0, row.created_at_key, row.id]);
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
    return this.forPortal(row === undefined ? platformDefaultTheme() : toTheme(row));
  }

  /**
   * Owner decision 71 (a) — the stored object key of a theme's light logo, for the portal to inline. Read on the same ambient transaction as
   * `themeForPortal`, pinned to the context's workspace. null = no logo (or no such theme). The key never leaves the server.
   */
  async portalLogoKey(themeId: string): Promise<string | null> {
    const { client } = this.store();
    const result = await client.query<{ key: string | null }>(
      `SELECT logo_light_key AS key FROM brand_themes WHERE id = $1 AND workspace_id = app.current_workspace()`,
      [themeId],
    );
    return result.rows[0]?.key ?? null;
  }

  /**
   * The portal's view of a theme, by an explicit field list (default deny): the agency's mail configuration (display name,
   * Reply-To) is never part of what a portal viewer is sent, so a field added to the editor's theme later stays out of the
   * portal until it is named here.
   */
  private forPortal(theme: AgencyThemeAdmin): AgencyTheme {
    return {
      theme_id: theme.theme_id,
      name: theme.name,
      is_default: theme.is_default,
      color_primary: theme.color_primary,
      color_accent: theme.color_accent,
      color_bg: theme.color_bg,
      color_fg: theme.color_fg,
      font_family: theme.font_family,
      // The stored logo's only route needs a workspace session and agency:branding, which an anonymous portal viewer has neither of:
      // sending its path would be a broken image and a theme id in a URL they cannot use. So it is null HERE and PortalContextInterceptor
      // fills it in, after its transaction, with the logo as a size-capped data: URL (owner decision 71 a; ThemeAssetsService.portalLogo).
      logo_url: null,
      hide_nominara_brand: theme.hide_nominara_brand,
      custom_css: this.safeCustomCss(theme),
    };
  }

  /**
   * Defence in depth: saveTheme is the only writer today, but a seed, a support fix or a later import could put raw text in
   * the column. The portal re-parses it against the theme's own colours and sends null when it is not acceptable as-is.
   */
  private safeCustomCss(theme: AgencyThemeAdmin): string | null {
    if (theme.custom_css === null) return null;
    const result = sanitiseCustomCss(theme.custom_css, theme);
    if (!result.ok) {
      this.logger.warn(`stored custom_css not servable theme_id=${theme.theme_id}`);
      return null;
    }
    return result.css === "" ? null : result.css;
  }


  /**
   * Creates (no `theme_id`, or the platform-default id) or updates a theme.
   * Everything is checked here, not in the editor: a direct API call must not
   * be able to save what the interface would refuse (STORY-097 scenario 8).
   */
  async saveTheme(body: UpdateAgencyThemeRequest): Promise<SaveAgencyThemeResponse> {
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

    const style = this.sanitiseStyleInputs(workspaceId, existing, body, colors);

    const font = body.font_family ?? existing?.font_family ?? DEFAULT_FONT_FAMILY;
    const hide = body.hide_nominara_brand ?? existing?.hide_nominara_brand ?? false;
    const name = body.name ?? existing?.name ?? DEFAULT_THEME_NAME;
    // Absent keeps the stored value; an explicit null clears it (the Reply-To header is then omitted).
    const emailFromName = body.email_from_name !== undefined ? body.email_from_name : (existing?.email_from_name ?? null);
    const emailReplyTo = body.email_reply_to !== undefined ? body.email_reply_to : (existing?.email_reply_to ?? null);

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
      row = await this.write(client, workspaceId, existing, { name, makeDefault, colors, font, hide, emailFromName, emailReplyTo, customCss: style.customCss, emailFooterHtml: style.emailFooterHtml });
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
    return { ...toTheme(row), dropped: style.dropped };
  }

  /**
   * STORY-097 — the style override and the email footer are parsed and RE-SERIALISED here, on the API path, so a client that
   * skips the editor cannot store raw input. A REFUSED construct (url(), @import, content, position:fixed, an escape sequence,
   * oversize) rejects the whole save naming it; anything merely unrecognised is dropped, stored without it, and returned in
   * `dropped`. An absent field keeps the stored value; an explicit null clears it. An empty result is stored as null.
   */
  private sanitiseStyleInputs(
    workspaceId: string,
    existing: ThemeRow | undefined,
    body: UpdateAgencyThemeRequest,
    colors: ThemeColors,
  ): { customCss: string | null; emailFooterHtml: string | null; dropped: SaveAgencyThemeResponse["dropped"] } {
    const dropped: SaveAgencyThemeResponse["dropped"] = { custom_css: [], email_footer_html: [] };
    let customCss = existing?.custom_css ?? null;
    let emailFooterHtml = existing?.email_footer_html ?? null;

    if (body.custom_css !== undefined) {
      if (body.custom_css === null) customCss = null;
      else {
        const result = sanitiseCustomCss(body.custom_css, colors);
        if (!result.ok) this.refuseStyle(workspaceId, "custom_css", result.refused.map((r) => ({ construct: r.construct, message: r.message })));
        else {
          customCss = result.css === "" ? null : result.css;
          dropped.custom_css = result.dropped.map((d) => ({ kind: d.kind, construct: d.construct, reason: d.reason }));
        }
      }
    }
    else if (customCss !== null) {
      // The stored override references the theme's colours, so a colour change is judged against it too: a save that would
      // make the existing override unreadable is refused like the override itself would be.
      const result = sanitiseCustomCss(customCss, colors);
      if (!result.ok) this.refuseStyle(workspaceId, "custom_css", result.refused.map((r) => ({ construct: r.construct, message: r.message })));
    }
    if (body.email_footer_html !== undefined) {
      if (body.email_footer_html === null) emailFooterHtml = null;
      else {
        const result = sanitiseEmailFooter(body.email_footer_html);
        if (!result.ok) this.refuseStyle(workspaceId, "email_footer_html", [{ construct: "size", message: result.reason }]);
        else {
          emailFooterHtml = result.html === "" ? null : result.html;
          dropped.email_footer_html = result.dropped.map((d) => ({ construct: d.construct, reason: d.reason }));
        }
      }
    }
    const droppedCount = dropped.custom_css.length + dropped.email_footer_html.length;
    if (droppedCount > 0) {
      incrementCounter("nominara_theme_style_dropped_total", { input: dropped.custom_css.length > 0 ? "custom_css" : "email_footer_html" });
      this.logger.log(`theme style input dropped workspace_id=${workspaceId} count=${String(droppedCount)}`);
    }
    return { customCss, emailFooterHtml, dropped };
  }

  private refuseStyle(workspaceId: string, field: string, refused: { construct: string; message: string }[]): never {
    for (const r of refused) incrementCounter("nominara_theme_style_refusals_total", { field, construct: r.construct });
    // Constructs only: the refused text itself is agency input and is never logged.
    this.logger.warn(`theme style refused workspace_id=${workspaceId} field=${field} constructs=${refused.map((r) => r.construct).join("|")}`);
    throw new ValidationFailedError({
      message: field + " contains a construct that is not allowed: " + refused.map((r) => r.construct).join(", "),
      details: styleRefusalDetailsSchema.parse({ issues: refused.map((r) => ({ path: [field], message: r.message })), refused }),
    });
  }

  private async write(
    client: ClientBase,
    workspaceId: string,
    existing: ThemeRow | undefined,
    v: {
      name: string;
      makeDefault: boolean;
      colors: ThemeColors;
      font: string;
      hide: boolean;
      emailFromName: string | null;
      emailReplyTo: string | null;
      customCss: string | null;
      emailFooterHtml: string | null;
    },
  ): Promise<ThemeRow> {
    const { name, makeDefault, colors, font, hide, emailFromName, emailReplyTo, customCss, emailFooterHtml } = v;
    let row: ThemeRow;
    if (existing === undefined) {
      const inserted = await client.query<ThemeRow>(
        `INSERT INTO brand_themes (workspace_id, name, is_default, color_primary, color_accent, color_bg, color_fg, font_family, hide_nominara_brand, email_from_name, email_reply_to, custom_css, email_footer_html)
         VALUES ($9, $1, $2, $3, $4, $5, $6, $7, $8, $10, $11, $12, $13)
         RETURNING ${COLUMNS}`,
        [name, makeDefault, colors.color_primary, colors.color_accent, colors.color_bg, colors.color_fg, font, hide, workspaceId, emailFromName, emailReplyTo, customCss, emailFooterHtml],
      );
      row = inserted.rows[0]!;
    } else {
      const updated = await client.query<ThemeRow>(
        `UPDATE brand_themes
            SET name = $2, is_default = $3, color_primary = $4, color_accent = $5, color_bg = $6, color_fg = $7,
                font_family = $8, hide_nominara_brand = $9, email_from_name = $10, email_reply_to = $11, custom_css = $12, email_footer_html = $13
          WHERE id = $1
          RETURNING ${COLUMNS}`,
        [existing.id, name, makeDefault, colors.color_primary, colors.color_accent, colors.color_bg, colors.color_fg, font, hide, emailFromName, emailReplyTo, customCss, emailFooterHtml],
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

function platformDefaultTheme(): AgencyThemeAdmin {
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
    email_from_name: null,
    email_reply_to: null,
    custom_css: null,
    email_footer_html: null,
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

import { z } from "zod";
import { agencyThemeSchema } from "../agency/theme.schema.js";
import { portalTabSchema } from "../agency/share-token.schema.js";
import { confidenceSchema } from "../analytics/scorecards-response.schema.js";
import { growthMapPointSchema, growthMapResponseSchema, growthMapSeriesSchema } from "../analytics/growth-map-response.schema.js";
import { methodologyFooterSchema } from "../reports/methodology-footer.schema.js";
import { dataSourceSchema } from "../analytics/data-source.schema.js";
import { reportTimeframeSchema } from "../reports/report-shared.schema.js";
import { lowercaseUuidSchema } from "../common/uuid.schema.js";

// NEW-E-0 — GET /v1/portal/{overview,growth-map,matrix,tasks,sources}.
// Auth: portal cookie only. GET only; every mutating verb on /portal/* is refused.
// integrations-and-sharing.md §4; STORY-098 scenarios 9-14, 22; STORY-099.
//
// `?project=` is a SELECTOR intersected with the cookie scope (planner
// interpretation, flagged for owner confirmation): an out-of-scope id is
// refused 403 `project_out_of_scope`, never widened. Project ids in the path
// or a header are ignored. `timeframe` cannot widen a token's timeframe_lock.
// Query schemas are .strict(): an unknown QUERY key is a 400.
//
// hide_costs removes every quota / capture-count / cost field; hide_competitors
// relabels to Competitor A/B/C and drops the comparison. The payload shapes
// below have no cost fields at all, so the key scan is structural.

/**
 * Owner decision 71 (a) — the portal's logo is an enveloped `data:` URL, because an anonymous viewer has no route to the
 * stored file. The envelope is closed: an image type the upload accepts (PNG, JPEG, WebP — never SVG, never `text/html`), base64
 * and nothing after it, at most 256 KB of decoded bytes. A value outside it fails the response parse, so it is never served.
 */
export const PORTAL_LOGO_MAX_BYTES = 256 * 1024;
const PORTAL_LOGO_ENVELOPE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
/** `data:image/jpeg;base64,` is the longest prefix (23 characters); base64 of 256 KiB is 349,528. */
export const PORTAL_LOGO_DATA_URL_MAX_LENGTH = 23 + 4 * Math.ceil(PORTAL_LOGO_MAX_BYTES / 3);
export const portalLogoDataUrlSchema = z.string().max(PORTAL_LOGO_DATA_URL_MAX_LENGTH).regex(PORTAL_LOGO_ENVELOPE);

/** The theme as the portal serves it: the agency theme with a logo that is a closed-envelope data URL or null. */
export const portalThemeSchema = agencyThemeSchema.extend({ logo_url: portalLogoDataUrlSchema.nullable() }).strict();

export const portalOverviewQuerySchema = z.object({ timeframe: reportTimeframeSchema.optional() }).strict();

export const portalProjectQuerySchema = z
  .object({ project: lowercaseUuidSchema, timeframe: reportTimeframeSchema.optional() })
  .strict();

export const portalTasksQuerySchema = z.object({ project: lowercaseUuidSchema }).strict();

/**
 * Owner decision 2026-10-08: when costs are hidden the footer drops `sample_size` (a figure derived from the capture
 * count). The footer itself stays, unremovable (NFR-AGY-05). So `sample_size` is OPTIONAL in the published schema: a
 * token with costs visible gets it, a hide_costs token does not. The two strict shapes the server enforces on the way
 * out are below; this one is what a client types against.
 */
export const portalMethodologyFooterSchema = methodologyFooterSchema.extend({ sample_size: methodologyFooterSchema.shape.sample_size.optional() }).strict();
/** The footer served under hide_costs: exactly the methodology footer without `sample_size`. */
export const portalHiddenCostsFooterSchema = methodologyFooterSchema.omit({ sample_size: true }).strict();

export const portalOverviewProjectSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    /** Null when unmeasured — never 0. */
    visibility: z.number().nullable(),
    delta: z.number().nullable(),
    confidence: confidenceSchema,
    sentiment: z.number().nullable(),
    citations: z.number().int().nonnegative(),
    /** The footer cannot be removed by theme (NFR-AGY-05). */
    footer: portalMethodologyFooterSchema,
  })
  .strict();

export const portalOverviewResponseSchema = z
  .object({
    agency: z.string(),
    theme: portalThemeSchema,
    label: z.string(),
    tabs: z.array(portalTabSchema),
    hide_competitors: z.boolean(),
    hide_costs: z.boolean(),
    timeframe: reportTimeframeSchema,
    timeframe_locked: z.boolean(),
    projects: z.array(portalOverviewProjectSchema),
  })
  .strict();

/** The two strict overview shapes the server enforces: costs visible (footer has sample_size) and hide_costs (it does not). */
export const portalOverviewCostsVisibleSchema = portalOverviewResponseSchema.extend({
  projects: z.array(portalOverviewProjectSchema.extend({ footer: methodologyFooterSchema })),
}).strict();
export const portalOverviewCostsHiddenSchema = portalOverviewResponseSchema.extend({
  projects: z.array(portalOverviewProjectSchema.extend({ footer: portalHiddenCostsFooterSchema })),
}).strict();

/**
 * The agency chart payload with ONE field removed from every point: `cells`, the per-day capture count. A capture count
 * is a cost-side figure (hide_costs, STORY-098 s12) and the portal chart never needs it, so it is absent for every
 * token rather than conditionally stripped. Milestones with visible_in_portal=false are filtered in SQL.
 */
export const portalGrowthMapPointSchema = growthMapPointSchema.omit({ cells: true });
export const portalGrowthMapSeriesSchema = growthMapSeriesSchema.extend({ points: z.array(portalGrowthMapPointSchema) }).strict();
export const portalGrowthMapResponseSchema = growthMapResponseSchema
  .extend({ series: z.array(portalGrowthMapSeriesSchema) })
  .strict();

export const portalMatrixEngineSchema = z
  .object({
    engine_key: z.string().min(1),
    /** Owner decision: Gemini is live, the rest demo — marked per engine. Null = nothing measured. */
    data_source: dataSourceSchema.nullable(),
    visibility_score: z.number().nullable(),
    presence_rate: z.number().nullable(),
    share_of_voice: z.number().nullable(),
  })
  .strict();

export const portalMatrixResponseSchema = z.object({ engines: z.array(portalMatrixEngineSchema) }).strict();

export const portalTaskMeasuredSchema = z
  .object({
    delta: z.number(),
    confidence: confidenceSchema,
    window_days: z.number().int().positive(),
    caveat: z.string(),
  })
  .strict();

export const portalTasksResponseSchema = z
  .object({
    completed: z.array(
      z
        .object({
          title: z.string(),
          completed_at: z.iso.datetime().nullable(),
          measured: portalTaskMeasuredSchema.nullable(),
        })
        .strict(),
    ),
    /** Ordered by impact; there is no ordering field. */
    open: z.array(
      z
        .object({
          title: z.string(),
          /** Null when the task has no measured severity (a manual task, or a gap not yet verified) — never invented. */
          severity: z.enum(["critical", "high", "medium", "low"]).nullable(),
          /** Open means not yet done and not dismissed; a task in review (contribution submitted, not yet verified) is still open. */
          status: z.enum(["todo", "in_progress", "in_review"]),
        })
        .strict(),
    ),
  })
  .strict();

export const portalSourceDomainSchema = z
  .object({
    domain: z.string(),
    influence: z.number().min(0).max(1),
    citations: z.number().int().nonnegative(),
    prompts: z.number().int().nonnegative(),
    source_class: z.enum([
      "community_forum",
      "review_marketplace",
      "developer_platform",
      "encyclopedic",
      "news_media",
      "blog",
      "vendor_owned",
      "academic",
      "government",
    ]),
    brand_present: z.boolean().nullable(),
    verified_at: z.iso.datetime().nullable(),
    gap_severity: z.enum(["critical", "high", "medium", "low", "none"]),
    top_urls: z.array(z.object({ url: z.string(), citations: z.number().int().nonnegative() }).strict()),
    /** Relabelled Competitor A/B/C (or empty) under hide_competitors. */
    competitors_present: z.array(z.string()),
  })
  .strict();

/** Read from project_source_index only. */
export const portalSourcesResponseSchema = z
  .object({
    window: z.object({ from: z.string(), to: z.string() }).strict(),
    /** Null when unmeasured; reported beside, never folded into, a composite. */
    source_coverage: z.number().min(0).max(100).nullable(),
    domains: z.array(portalSourceDomainSchema),
  })
  .strict();

export type PortalOverviewResponse = z.infer<typeof portalOverviewResponseSchema>;
export type PortalGrowthMapResponse = z.infer<typeof portalGrowthMapResponseSchema>;
export type PortalGrowthMapQuery = z.infer<typeof portalProjectQuerySchema>;
export type PortalOverviewQuery = z.infer<typeof portalOverviewQuerySchema>;
export type PortalMatrixResponse = z.infer<typeof portalMatrixResponseSchema>;
export type PortalTasksQuery = z.infer<typeof portalTasksQuerySchema>;
export type PortalTasksResponse = z.infer<typeof portalTasksResponseSchema>;
export type PortalSourcesResponse = z.infer<typeof portalSourcesResponseSchema>;

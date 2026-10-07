import { z } from "zod";
import { agencyThemeSchema } from "../agency/theme.schema.js";
import { portalTabSchema } from "../agency/share-token.schema.js";
import { confidenceSchema } from "../analytics/scorecards-response.schema.js";
import { growthMapResponseSchema } from "../analytics/growth-map-response.schema.js";
import { methodologyFooterSchema } from "../reports/methodology-footer.schema.js";
import { dataSourceSchema } from "../analytics/data-source.schema.js";
import { reportTimeframeSchema } from "../reports/report-shared.schema.js";

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

export const portalOverviewQuerySchema = z.object({ timeframe: reportTimeframeSchema.optional() }).strict();

export const portalProjectQuerySchema = z
  .object({ project: z.uuid(), timeframe: reportTimeframeSchema.optional() })
  .strict();

export const portalTasksQuerySchema = z.object({ project: z.uuid() }).strict();

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
    footer: methodologyFooterSchema,
  })
  .strict();

export const portalOverviewResponseSchema = z
  .object({
    agency: z.string(),
    theme: agencyThemeSchema,
    label: z.string(),
    tabs: z.array(portalTabSchema),
    hide_competitors: z.boolean(),
    hide_costs: z.boolean(),
    timeframe: reportTimeframeSchema,
    timeframe_locked: z.boolean(),
    projects: z.array(portalOverviewProjectSchema),
  })
  .strict();

/** Same chart payload as the agency side; milestones with visible_in_portal=false are filtered in SQL. */
export const portalGrowthMapResponseSchema = growthMapResponseSchema;

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
          severity: z.enum(["critical", "high", "medium", "low"]),
          status: z.enum(["todo", "in_progress", "done", "dismissed"]),
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
export type PortalMatrixResponse = z.infer<typeof portalMatrixResponseSchema>;
export type PortalTasksResponse = z.infer<typeof portalTasksResponseSchema>;
export type PortalSourcesResponse = z.infer<typeof portalSourcesResponseSchema>;

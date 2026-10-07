import { z } from "zod";
import { dataSourceSchema, engineDataSourceSchema } from "./data-source.schema.js";

// STORY-137 — `GET /v1/projects/{id}/growth-map`, `api-specification.md` §7.
//
// ONE PAYLOAD FOR THE WHOLE CHART. STORY-090's note: "engines times days
// times competitors is thousands of points, and per-series fetching both
// misses the paint budget and produces a chart that assembles itself
// visibly."

export const growthMapQuerySchema = z
  .object({
    timeframe: z.enum(["7d", "30d", "90d"]).default("90d"),
    /** `brand`, `competitors`, or both — §7's own query string. */
    entities: z.string().min(1).optional(),
    granularity: z.enum(["day"]).default("day"),
  })
  .strict();

/**
 * One day on one series.
 *
 * ⚠ A DAY WITH NO CELLS IS `null` HERE AND A GAP IN `data_gaps`. §7 is
 * explicit: "a day with `cells_total = 0` is `null` in `points` and appears
 * in `annotations.data_gaps` — IT IS NEVER INTERPOLATED."
 *
 * The point still exists, with its date, so a renderer walking the array gets
 * one entry per day and does not have to reconstruct the calendar. What it
 * must not do is join across the null, which is why the gap is also
 * announced separately: a line that bridges a missing day asserts a
 * measurement nobody made, in the most persuasive form the product has.
 */
export const growthMapPointSchema = z
  .object({
    d: z.string(),
    visibility_score: z.number().nullable(),
    sov: z.number().nullable(),
    cells: z.number().int().nonnegative(),
    live_ratio: z.number().nullable(),
  })
  .strict();

export const growthMapSeriesSchema = z
  .object({
    series_id: z.string().min(1),
    label: z.string().min(1),
    entity_type: z.enum(["brand", "competitor", "derived"]),
    color_role: z.enum(["primary", "comparison", "baseline"]),
    points: z.array(growthMapPointSchema),
    /** NEW-A-5 — provenance of the captures in the window; null when none were measured. */
    data_source: dataSourceSchema.nullable().optional(),
  })
  .strict();

/**
 * §7's `measured_impact`, with the caveat REQUIRED rather than optional.
 *
 * `scoring-models.md` §14: "every rendered impact figure carries the
 * mandatory caveat string", and `NFR-ANL-05` makes it lint-enforced on the
 * copy side. Making it required here closes the other end: a milestone
 * cannot reach a tooltip carrying a delta and no disclaimer, whatever the
 * stored jsonb happens to contain.
 */
export const measuredImpactSchema = z
  .object({
    visibility_before: z.number(),
    visibility_after_14d: z.number(),
    delta: z.number(),
    window_days: z.number().int().positive(),
    confidence: z.enum(["low", "medium", "high"]),
    method: z.string().min(1),
    caveat: z.string().min(1),
  })
  .strict();

export const milestoneSchema = z
  .object({
    milestone_id: z.string().uuid(),
    occurred_at: z.string().datetime({ offset: true }),
    kind: z.string().min(1),
    title: z.string().min(1),
    detail: z.string().nullable(),
    severity: z.enum(["info", "positive", "warning"]),
    source: z
      .object({ type: z.string().min(1), id: z.string().uuid().nullable() })
      .strict()
      .nullable(),
    affected_engines: z.array(z.string()),
    /** Null when the milestone has no computed impact — most do not. */
    measured_impact: measuredImpactSchema.nullable(),
    visible_in_portal: z.boolean(),
  })
  .strict();

export const dataGapSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    /**
     * WHY the day is missing, because "no data" and "the engine was down"
     * are different facts — the same distinction the matrix draws between a
     * pending cell and a failed one.
     */
    reason: z.enum(["engine_unavailable", "no_capture"]),
    engines: z.array(z.string()),
  })
  .strict();

export const growthMapResponseSchema = z
  .object({
    granularity: z.literal("day"),
    timeframe: z.object({ from: z.string(), to: z.string(), timezone: z.string() }).strict(),
    series: z.array(growthMapSeriesSchema),
    /** NEW-A-5 — per-engine provenance over the window, one entry per engine measured. */
    engines: z.array(engineDataSourceSchema).optional(),
    milestones: z.array(milestoneSchema),
    annotations: z
      .object({
        data_gaps: z.array(dataGapSchema),
        /**
         * ALWAYS EMPTY TODAY, and the contract keeps the field rather than
         * dropping it. `project_engines` has no history table and nothing
         * records a cadence change, so there is no source to read — see the
         * service. Removing the field would make the chart's own annotation
         * layer look complete when one of its two kinds is unimplemented.
         */
        cadence_changes: z.array(
          z.object({ at: z.string(), from: z.string(), to: z.string() }).strict(),
        ),
      })
      .strict(),
    /** Null throughout when the window measured nothing — never 0. */
    summary: z
      .object({
        visibility_start: z.number().nullable(),
        visibility_end: z.number().nullable(),
        visibility_delta: z.number().nullable(),
        best_engine: z.string().nullable(),
        worst_engine: z.string().nullable(),
        competitor_gap_start: z.number().nullable(),
        competitor_gap_end: z.number().nullable(),
      })
      .strict(),
    point_count: z.number().int().nonnegative(),
  })
  .strict();

export type GrowthMapQuery = z.infer<typeof growthMapQuerySchema>;
export type GrowthMapPoint = z.infer<typeof growthMapPointSchema>;
export type GrowthMapSeries = z.infer<typeof growthMapSeriesSchema>;
export type Milestone = z.infer<typeof milestoneSchema>;
export type MeasuredImpact = z.infer<typeof measuredImpactSchema>;
export type DataGap = z.infer<typeof dataGapSchema>;
export type GrowthMapResponse = z.infer<typeof growthMapResponseSchema>;

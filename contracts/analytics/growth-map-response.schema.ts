import { z } from "zod";
import { measuredImpactSchema as writtenMeasuredImpactSchema } from "../tasks/task-verification.schema.js";
import { customRangeDays, customRangeFields, customRangeGranularity, refineCustomRange } from "./custom-range.schema.js";
import { dataSourceSchema, engineDataSourceSchema } from "./data-source.schema.js";

// STORY-137 — `GET /v1/projects/{id}/growth-map`, `api-specification.md` §7.
//
// ONE PAYLOAD FOR THE WHOLE CHART. STORY-090's note: "engines times days
// times competitors is thousands of points, and per-series fetching both
// misses the paint budget and produces a chart that assembles itself
// visibly."

/** `all`, or a comma list of engine keys. `all` beside a key is ambiguous, so it is a 400. */
export const engineFilterSchema = z
  .string()
  .min(1)
  .refine(
    (value) => {
      const keys = value.split(",").map((key) => key.trim());
      if (keys.some((key) => !/^[a-z0-9_]+$/.test(key))) return false;
      return !keys.includes("all") || keys.length === 1;
    },
    { message: "engines is `all` or a comma list of engine keys" },
  );

/**
 * STORY-066 AC1/AC2 — the timeframes the chart serves. `scoring-models.md` §13:
 * "Granularity auto-selects: `24h → hour`, `7d/30d/90d → day`, `>90d → week`".
 * The two longer windows are named `180d` and `365d` (planner recommendation,
 * 2026-10-26); a custom range is STORY-090's.
 */
export const growthMapTimeframeSchema = z.enum(["24h", "7d", "30d", "90d", "180d", "365d", "custom"]);
export const growthMapGranularitySchema = z.enum(["hour", "day", "week"]);

/** §13's auto-selection, as data, so the server and a client cannot disagree about it. A custom range selects by its own length (`customRangeGranularity`). */
export const GROWTH_MAP_GRANULARITY: Readonly<Record<Exclude<z.infer<typeof growthMapTimeframeSchema>, "custom">, z.infer<typeof growthMapGranularitySchema>>> =
  Object.freeze({ "24h": "hour", "7d": "day", "30d": "day", "90d": "day", "180d": "week", "365d": "week" });

export const growthMapQuerySchema = z
  .object({
    timeframe: growthMapTimeframeSchema.default("90d"),
    /** `brand`, `competitors`, or both — §7's own query string. */
    entities: z.string().min(1).optional(),
    /**
     * api-specification §7 — a comma list of engine keys, or `all`. NARROWING
     * ONLY: it can drop engines from the project's entitled set, never add
     * one. `all` means the entitled set and stands alone.
     */
    engines: engineFilterSchema.optional(),
    /**
     * AUTO-SELECTED from the timeframe (§13). Optional, and when sent it must
     * be the one the timeframe selects: a client that asked for daily points
     * over a year and was quietly served weekly ones would believe it had read
     * daily values. A mismatch is a 400, never a silent substitution.
     */
    granularity: growthMapGranularitySchema.optional(),
    /** STORY-090: with `timeframe=custom`, the workspace-local days plotted (both inclusive) - see custom-range.schema.ts. */
    ...customRangeFields,
  })
  .strict()
  .superRefine((query, ctx) => {
    refineCustomRange(query, ctx);
    const selected =
      query.timeframe !== "custom"
        ? GROWTH_MAP_GRANULARITY[query.timeframe]
        : query.from !== undefined && query.to !== undefined
          ? customRangeGranularity(customRangeDays(query.from, query.to))
          : undefined;
    if (query.granularity !== undefined && selected !== undefined && query.granularity !== selected) {
      ctx.addIssue({
        code: "custom",
        path: ["granularity"],
        message: `timeframe ${query.timeframe} is served at ${selected} granularity`,
      });
    }
  });

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
    /**
     * The bucket's label. `day`: the workspace-local date (`YYYY-MM-DD`).
     * `week`: the first workspace-local date of the seven-day bucket (buckets
     * end on the window's last day, so the first one may be shorter). `hour`:
     * the UTC instant the hour starts (`YYYY-MM-DDTHH:00:00Z`) — an instant,
     * because a wall-clock hour repeats on the night the clocks go back.
     */
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
export const measuredImpactSchema = writtenMeasuredImpactSchema
  .pick({ visibility_before: true, visibility_after_14d: true, delta: true, window_days: true, confidence: true, method: true })
  // The READER accepts any non-empty caveat (a future method may say something more specific); the WRITER's is the one constant.
  .extend({ caveat: z.string().min(1) })
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
    granularity: growthMapGranularitySchema,
    /** Workspace-local dates; at `hour` granularity, the UTC instants of the first and last hour. */
    timeframe: z.object({ from: z.string(), to: z.string(), timezone: z.string() }).strict(),
    series: z.array(growthMapSeriesSchema),
    /** NEW-A-5 — per-engine provenance over the window, one entry per engine measured. */
    engines: z.array(engineDataSourceSchema).optional(),
    milestones: z.array(milestoneSchema),
    annotations: z
      .object({
        data_gaps: z.array(dataGapSchema),
        /**
         * STORY-066 AC5 — every capture-cadence change in the window, so a
         * weekly→daily switch does not read as a trend break. Read from the
         * milestones the `record_cadence_change` trigger (migration 0017)
         * writes. `at` is labelled like a point's `d`: a workspace-local date,
         * or the UTC hour instant at `hour` granularity.
         */
        cadence_changes: z.array(
          z.object({ at: z.string(), from: z.string(), to: z.string() }).strict(),
        ),
        /**
         * STORY-066 AC12 — where the plotted series crosses from one
         * `scoring_version` to another. A day is plotted under the current
         * version when it has one and under the most recent older version
         * otherwise (history past raw-capture retention cannot be rebuilt),
         * and each change between consecutive measured buckets is announced
         * here: `at` is the first bucket under `to`. Empty when the window
         * is all one version.
         */
        scoring_version_changes: z.array(
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
export type GrowthMapTimeframe = z.infer<typeof growthMapTimeframeSchema>;
export type GrowthMapGranularity = z.infer<typeof growthMapGranularitySchema>;
export type GrowthMapPoint = z.infer<typeof growthMapPointSchema>;
export type GrowthMapSeries = z.infer<typeof growthMapSeriesSchema>;
export type Milestone = z.infer<typeof milestoneSchema>;
export type MeasuredImpact = z.infer<typeof measuredImpactSchema>;
export type DataGap = z.infer<typeof dataGapSchema>;
export type GrowthMapResponse = z.infer<typeof growthMapResponseSchema>;

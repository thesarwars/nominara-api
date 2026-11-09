import { z } from "zod";

// STORY-114 - api-specification.md section 3: `GET /projects/{id}/attribution` (`tracking:read`). The per-URL join of our citations,
// first-party AI sessions, conversions and (where Search Console is connected) AI-surface impressions and organic clicks, with the
// pattern each URL classifies to (scoring-models.md section 11). It reads `attribution_url_rollup` only.

/** `attribution_url_rollup.pattern` CHECK. */
export const ATTRIBUTION_PATTERNS = ["dual_visibility", "ai_only", "organic_only", "ai_substitution_candidate", "invisible_both", "insufficient_data"] as const;
export type AttributionPattern = (typeof ATTRIBUTION_PATTERNS)[number];

/** `attribution_url_rollup.window_days` CHECK. */
export const ATTRIBUTION_WINDOW_DAYS = [7, 30, 90] as const;
export type AttributionWindowDays = (typeof ATTRIBUTION_WINDOW_DAYS)[number];

/**
 * THE SHARED COPY (NFR-ANL-05). The substitution pattern is reported as co-movement and never as causation: citations rising
 * while sessions fall has other plausible explanations that cannot be ruled out. Every surface that words this pattern reads
 * these constants; none writes its own.
 */
export const SUBSTITUTION_CO_MOVEMENT_COPY =
  "Citations rose while AI-referred sessions fell on this page. The two moved together; this is an observation, and other explanations cannot be ruled out.";

/** NFR-ANL-09 - the label every attribution figure carries: a measured floor, never an estimated total. */
export const MEASURED_FLOOR_COPY =
  "Figures are measured counts and a floor: sessions whose referrer was stripped appear as unattributed direct and are not estimated into the AI total.";

export const attributionQuerySchema = z
  .object({
    timeframe: z.enum(["7d", "30d", "90d"]).default("30d"),
    pattern: z.enum(ATTRIBUTION_PATTERNS).optional(),
  })
  .strict();
export type AttributionQuery = z.infer<typeof attributionQuerySchema>;

export const attributionRowSchema = z.object({
  url: z.string(),
  citations: z.number().int().min(0),
  citations_prior: z.number().int().min(0),
  ai_sessions: z.number().int().min(0),
  ai_sessions_prior: z.number().int().min(0),
  conversions: z.number().int().min(0),
  /** `null` when there were no sessions: a page with none has no conversion rate, and a zero would rank it below one that converts poorly. */
  conversion_rate: z.number().min(0).nullable(),
  /** `null` when Search Console is not connected, never 0. */
  gsc_ai_impressions: z.number().int().min(0).nullable(),
  organic_clicks: z.number().int().min(0).nullable(),
  pattern: z.enum(ATTRIBUTION_PATTERNS),
  /** True for `ai_substitution_candidate`: the row is surfaced first and carries `note`. */
  flagged: z.boolean(),
  /** `SUBSTITUTION_CO_MOVEMENT_COPY` on a flagged row, otherwise `null`. */
  note: z.string().nullable(),
});
export type AttributionRow = z.infer<typeof attributionRowSchema>;

/** `attribution_daily.referrer_class` CHECK: a referrer taxonomy, NOT the engine set (it has no Google surface; it adds `other_ai` and the stripped class). */
export const ATTRIBUTION_AI_REFERRER_CLASSES = ["chatgpt", "perplexity", "gemini", "claude", "copilot", "meta_ai", "other_ai"] as const;
export type AttributionAiReferrerClass = (typeof ATTRIBUTION_AI_REFERRER_CLASSES)[number];

/** One measured count for the window and for the window before it, so the movement is read off one object. Both are counts, never estimates. */
export const attributionFigureSchema = z.object({
  current: z.number().int().min(0),
  prior: z.number().int().min(0),
  /** `current - prior`. */
  delta: z.number().int(),
  /** `delta / prior`; `null` when `prior` is 0, because a change from nothing has no percentage and a zero would read as "flat". */
  delta_pct: z.number().nullable(),
});
export type AttributionFigure = z.infer<typeof attributionFigureSchema>;

export const attributionEngineBreakdownSchema = z.object({
  referrer_class: z.enum(ATTRIBUTION_AI_REFERRER_CLASSES),
  sessions: attributionFigureSchema,
  conversions: attributionFigureSchema,
});
export type AttributionEngineBreakdown = z.infer<typeof attributionEngineBreakdownSchema>;

/**
 * The project-wide figures of the window the rows describe (STORY-116 F1/F2), read from the beacon's daily counts over the SAME window
 * and prior window as the rollup. Every value is a measured count or a ratio of two; nothing is scaled, so the AI figures are a floor.
 * `unattributed` is the sessions whose referrer was stripped: displayed beside the AI figures and NEVER added into them.
 */
export const attributionTotalsSchema = z.object({
  ai_sessions: attributionFigureSchema,
  conversions: attributionFigureSchema,
  /** `conversions / ai_sessions`; `null` when there were no AI sessions, never 0. */
  conversion_rate: z.number().min(0).nullable(),
  conversion_rate_prior: z.number().min(0).nullable(),
  /** Every AI referrer class, in a fixed order; a class with no sessions is a measured 0. */
  by_engine: z.array(attributionEngineBreakdownSchema),
  unattributed: z.object({ sessions: attributionFigureSchema, conversions: attributionFigureSchema }),
});
export type AttributionTotals = z.infer<typeof attributionTotalsSchema>;

export const attributionReportSchema = z.object({
  window_days: z.union([z.literal(7), z.literal(30), z.literal(90)]),
  /** The first day of the window the rows describe, `YYYY-MM-DD`; `null` when no rollup has been computed yet. */
  window_start: z.string().nullable(),
  computed_at: z.string().nullable(),
  /** Whether Search Console is connected; when false the impression and click columns are `null` on every row. */
  gsc_connected: z.boolean(),
  /** How many rows are substitution candidates, so the interface can lead with them. */
  substitution_candidates: z.number().int().min(0),
  measured_floor_note: z.string(),
  /** `null` until a rollup window has been computed (there is no window to total), never zeros. Not narrowed by the `pattern` filter. */
  totals: attributionTotalsSchema.nullable(),
  rows: z.array(attributionRowSchema),
});
export type AttributionReport = z.infer<typeof attributionReportSchema>;

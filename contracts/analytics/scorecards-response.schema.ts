import { z } from "zod";
import { blendDisclosureSchema, dataSourceSchema } from "./data-source.schema.js";

// STORY-136 — `GET /v1/projects/{id}/scorecards`, `api-specification.md` §3's
// Analytics row: "per-engine and blended score, presence, share of voice,
// sentiment, citations, rendering, with deltas and confidence".
//
// EVERY METRIC IS INDEPENDENTLY NULLABLE, and that is the whole contract.
// STORY-090 AC5: "a null metric renders as an em dash. Rendering quality and
// sentiment are LEGITIMATELY ABSENT in many projects and must never read as
// zero." A schema with `z.number()` on any of these would make the screen's
// honesty rule unrepresentable on the wire.

export const scorecardTimeframeSchema = z.enum(["7d", "30d", "90d"]).default("30d");

export const scorecardsQuerySchema = z
  .object({
    timeframe: scorecardTimeframeSchema,
    /** Comma-separated engine keys. A NARROWING of the project's enabled set. */
    engines: z.string().min(1).optional(),
  })
  .strict();

/** §3's band — `low` under 30 measured cells, `medium` to 120, `high` above. */
export const confidenceSchema = z.enum(["low", "medium", "high"]);

export const scorecardMetricsSchema = z
  .object({
    /**
     * §3 — `PresenceRate(T)` in [0,1]. Null when nothing was measured.
     *
     * ZERO IS A REAL RESULT: every engine answered and none named the brand.
     * Null is the absence of a measurement. The two must never collapse.
     */
    presence_rate: z.number().nullable(),
    /** §2.3 — `SoV(b, T)` in [0,1]. 0 with cells measured is a real finding. */
    share_of_voice: z.number().nullable(),
    /**
     * §6 — `SentimentScore(T)` in [0,100]. Null when nothing was mentioned:
     * on a 0–100 scale 0 is MAXIMALLY NEGATIVE, not "no data".
     */
    sentiment_score: z.number().nullable(),
    /**
     * §4 — owned share of the cited corpus, in [0,1]. Null when nothing was
     * cited at all, which is different from "cited, and none of it was mine".
     */
    citation_share: z.number().nullable(),
    /** §8 — in [0,100], over attribute-capable engines only. Null otherwise. */
    rendering_quality: z.number().nullable(),
    /** The raw counts the ratios above were derived from, so a client can audit them. */
    cells_total: z.number().int().nonnegative(),
    cells_present: z.number().int().nonnegative(),
    mentions_total: z.number().int().nonnegative(),
    citations_total: z.number().int().nonnegative(),
    citations_owned: z.number().int().nonnegative(),
  })
  .strict();

/**
 * STORY-090 AC4 — "each with a period delta SUPPRESSED BELOW THE CONFIDENCE
 * THRESHOLD".
 *
 * Computed server-side, under the same `n < 30` rule as the Visibility
 * Score's own delta, so the suppression lives in one place. A client
 * subtracting two windows itself would have to re-implement `NFR-ANL-03`,
 * and the first screen that forgot would publish a trend arrow on four
 * cells.
 *
 * Every field is nullable twice over: null when the windows are
 * under-sampled, and null when the metric itself was never measured in
 * either window. Neither is zero.
 */
export const scorecardMetricsDeltaSchema = z
  .object({
    presence_rate: z.number().nullable(),
    share_of_voice: z.number().nullable(),
    sentiment_score: z.number().nullable(),
    citation_share: z.number().nullable(),
    rendering_quality: z.number().nullable(),
  })
  .strict();

export const scorecardEntrySchema = z
  .object({
    /** An engine key, or `all` for the blended entry. */
    engine_key: z.string().min(1),
    /** Null on the blended entry, which is not an engine. */
    display_name: z.string().nullable(),
    /**
     * AC2 — THE CADENCE, RESOLVED THE WAY THE SCHEDULER RESOLVES IT.
     *
     * `engines.cadence_by_plan -> {plan} ->> 'full'`, runs per 30-day cycle
     * — the same expression `resolveDueEngines` evaluates.
     * `schemas/captures-and-facts.md` is explicit that this is the only
     * source: "`cadence_by_plan` x `project_engines.enabled` is the only
     * source the scheduler reads and the only source the per-engine
     * freshness row renders, which is why the customer-visible cadence
     * cannot drift from what actually runs."
     *
     * A NUMBER, NOT A LABEL. "Daily" is a rendering of `30`; storing the
     * rendering is how a screen ends up claiming daily while the scheduler
     * runs weekly, which STORY-090's notes call the most embarrassing kind
     * of drift.
     *
     * NULL MEANS THIS PLAN DOES NOT SCHEDULE THIS ENGINE — the scheduler's
     * own fail-closed rule, not a missing value. It is also what every
     * engine reports today, because `engines.cadence_by_plan` defaults to
     * `{}` and nothing seeds the catalog (STORY-130).
     */
    cadence_runs_per_cycle: z.number().int().positive().nullable(),
    /** §3's 0–100 composite. Null when no component was measurable. */
    visibility_score: z.number().nullable(),
    /**
     * §3 — the difference against the PRIOR ALIGNED WINDOW.
     *
     * NULL, NOT ZERO, when either window has fewer than 30 measured cells.
     * `NFR-ANL-03` forbids a trend delta below that, and a zero delta is a
     * claim that nothing changed — which renders as a flat arrow, the most
     * confident-looking thing in the interface.
     */
    visibility_delta: z.number().nullable(),
    confidence: confidenceSchema,
    /** §3's Wald half-width on the score. Null when there is nothing to bound. */
    confidence_half_width: z.number().nullable(),
    /** The denominator behind everything above. `0` on an engine with no rows. */
    measured_cells: z.number().int().nonnegative(),
    metrics: scorecardMetricsSchema,
    metrics_delta: scorecardMetricsDeltaSchema,
    /**
     * STORY-090 AC — "the header shows LAST SCAN TIME PER ENGINE".
     *
     * The last capture that actually produced an answer on this engine, from
     * `answer_captures`, and NOT WINDOWED: an engine that last answered
     * before the window is exactly the one worth surfacing, and clamping it
     * would report null for the engine that has been silent longest. Same
     * rule as the matrix cell's `last_success_at`.
     */
    last_captured_at: z.string().datetime({ offset: true }).nullable(),
    /**
     * STORY-090 AC — "the NEXT SCHEDULED RUNS, each marked included and
     * zero-credit".
     *
     * `last_captured_at + 30 days / cadence_runs_per_cycle`, the same
     * arithmetic `resolveDueEngines` uses to decide due-ness. Null when the
     * plan does not schedule this engine, or when it has never run — there
     * is no "next" to compute from a cadence that does not exist.
     */
    next_run_at: z.string().datetime({ offset: true }).nullable(),
    /**
     * NEW-A-5 — whether the measured captures behind this entry are real or
     * demo-seeded. Null when nothing was measured; never "demo" by default.
     * On the blended entry: the combination across every engine in the blend.
     */
    data_source: dataSourceSchema.nullable(),
  })
  .strict();

export const scorecardsResponseSchema = z
  .object({
    project_id: z.string().uuid(),
    timeframe: z.enum(["7d", "30d", "90d"]),
    /** The window actually measured, in the PROJECT'S timezone. */
    window: z
      .object({
        from: z.string(),
        to: z.string(),
        timezone: z.string(),
      })
      .strict(),
    /**
     * PER-ENGINE FIRST, and the blend is a sibling rather than a wrapper.
     *
     * STORY-090 AC1: "per-engine scores are primary and the blend renders
     * beside them; THE BLEND NEVER APPEARS ALONE." A response shaped as
     * `{blended, engines[]}` invites a client to render the first field and
     * stop. One list with the blend in it cannot be read that way.
     */
    engines: z.array(scorecardEntrySchema),
    blended: scorecardEntrySchema,
    /** NEW-A-5 — which engines fed `blended`, by provenance. */
    blend: blendDisclosureSchema,
  })
  .strict();

export type ScorecardsQuery = z.infer<typeof scorecardsQuerySchema>;
export type ScorecardMetrics = z.infer<typeof scorecardMetricsSchema>;
export type ScorecardMetricsDelta = z.infer<typeof scorecardMetricsDeltaSchema>;
export type ScorecardEntry = z.infer<typeof scorecardEntrySchema>;
export type ScorecardsResponse = z.infer<typeof scorecardsResponseSchema>;

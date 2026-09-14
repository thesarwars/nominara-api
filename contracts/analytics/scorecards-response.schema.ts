import { z } from "zod";

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

export const scorecardEntrySchema = z
  .object({
    /** An engine key, or `all` for the blended entry. */
    engine_key: z.string().min(1),
    /** Null for the blend; the engine's own cadence otherwise. */
    display_name: z.string().nullable(),
    /**
     * AC2 — RESOLVED FROM `project_engines`, the same row the scheduler
     * reads. A static label here is the drift STORY-090's notes call "the
     * most embarrassing kind": a screen claiming daily while the scheduler
     * runs weekly.
     */
    cadence: z.string().nullable(),
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
  })
  .strict();

export type ScorecardsQuery = z.infer<typeof scorecardsQuerySchema>;
export type ScorecardMetrics = z.infer<typeof scorecardMetricsSchema>;
export type ScorecardEntry = z.infer<typeof scorecardEntrySchema>;
export type ScorecardsResponse = z.infer<typeof scorecardsResponseSchema>;

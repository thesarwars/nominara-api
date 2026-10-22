import { z } from "zod";
import { confidenceSchema } from "../analytics/scorecards-response.schema.js";
import { DISCOVERY_STATUSES } from "./create-project-response.schema.js";

// STORY-132 — the workspace matrix row. api-specification.md §3:
// "GET /projects — workspace matrix; includes visibility_blended,
// sparkline_30d, open_task_count".
//
// THE SCORE FIELDS ARE NULLABLE, AND THAT IS THE HONEST SHAPE. Their producer
// is STORY-042's rollup worker, which sits behind the parser and the scoring
// core in Slice 4. The columns exist on `projects` and are genuinely NULL
// until a rollup runs, so a null here reports the truth; a 0 would assert a
// score of zero, which is a different and false claim. lib/copy/metrics.ts
// draws the same distinction on the client — absence is not zero.

/** §6's displayed sentiment bands — null when the score itself is null. */
export const sentimentBandSchema = z.enum(["positive", "neutral", "negative"]);

export const projectEngineScoreSchema = z
  .object({
    engine_key: z.string().min(1),
    score: z.number(),
    /** Same 30-cell threshold rule as every other delta on this row. */
    delta_30d: z.number().nullable(),
  })
  .strict();

export const openTasksBySeveritySchema = z
  .object({
    critical: z.number().int().nonnegative(),
    high: z.number().int().nonnegative(),
    medium: z.number().int().nonnegative(),
    low: z.number().int().nonnegative(),
  })
  .strict();

/**
 * STORY-169 review — `projects.visibility_by_engine`'s STORED jsonb shape:
 * `{engine_key: {score, delta_30d}}`, keyed by engine, written by
 * `denormalizeProject`'s `perEngineWindow`. This is NOT the same shape as
 * `engine_scores` above (the WIRE contract: a score-sorted ARRAY with
 * `engine_key` embedded in each entry) — `ProjectsService`'s own
 * `toEngineScores` is what converts one into the other at read time.
 * `coding-standards.md` requires a zod schema for every jsonb column; this
 * was previously read through a hand-written `ProjectEngineScoreRow`
 * TypeScript interface with no runtime check at all.
 */
export const storedEngineScoreSchema = projectEngineScoreSchema.omit({ engine_key: true });
export const visibilityByEngineSchema = z.record(z.string(), storedEngineScoreSchema);

// STORY-175 AC1 - the state of the project's LATEST capture run, so a card can
// tell "never measured" (null) from "measuring right now" (queued/running) from
// "measured, scores not written yet" (terminal, rolled_up false).
//
// `completed_at` is the run's `finished_at`; every terminal status has one, a
// failed or canceled run included. `rolled_up` is true once the project's
// denormalised block was rewritten at or after the run finished (see
// ProjectsService.LAST_SCAN_JOIN); it is meaningful for a terminal run only.
// Counts are never null: 0 is a real count, and "no run" is `last_scan: null`.
export const lastScanSchema = z
  .object({
    run_id: z.string().uuid(),
    status: z.enum(["queued", "running", "completed", "partial", "failed", "canceled"]),
    trigger: z.enum(["scheduled", "manual", "verification", "drift_sample", "conversion_backfill"]),
    planned_cells: z.number().int().nonnegative(),
    /** captured + failed + skipped. */
    settled_cells: z.number().int().nonnegative(),
    captured_cells: z.number().int().nonnegative(),
    started_at: z.string().nullable(),
    completed_at: z.string().nullable(),
    rolled_up: z.boolean(),
  })
  .strict();

export const projectListItemSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    root_domain: z.string(),
    kind: z.enum(["brand", "product_line"]),
    status: z.string(),
    /**
     * STORY-077 — set (with `status: "paused"`) when a downgrade paused this project at its cut-over; null otherwise,
     * including when a person paused it. A downgrade pause resumes automatically on a later upgrade.
     */
    paused_by_downgrade_at: z.string().nullable(),
    discovery_status: z.enum(DISCOVERY_STATUSES),

    prompts_active: z.number().int().nonnegative(),
    prompts_cap: z.number().int().nonnegative(),
    open_task_count: z.number().int().nonnegative(),
    /** STORY-169 — open, non-deleted tasks by derived severity. Never absent: a count has no honest "no data" state. */
    open_tasks_by_severity: openTasksBySeveritySchema,

    /** Null until the domain is verified — gates audit scope, not price. */
    domain_verified_at: z.string().nullable(),
    created_at: z.string(),

    // --- filled by STORY-042's rollup worker, null until then ---
    visibility_blended: z.number().nullable(),
    visibility_delta_30d: z.number().nullable(),
    /** §8's 0–100 composite, over attribute-capable engines only. Null otherwise. */
    rendering_quality: z.number().nullable(),
    /** STORY-169 — current vs prior 30d window mean. Same NFR-ANL-03 gate as visibility_delta_30d: null unless both windows have >= 30 measured cells. */
    rendering_delta_30d: z.number().nullable(),
    /** STORY-169 — 100*(1 - Σ context_weight of critical/high gap domains). Null with no project_source_index rows. */
    source_coverage: z.number().nullable(),
    aux_score_current: z.number().nullable(),
    /** §6's 0–100 composite, latest day. Null when the day had no mentions — never 50. */
    sentiment_score: z.number().nullable(),
    /** STORY-169 — same window/threshold rule as visibility_delta_30d. */
    sentiment_delta_30d: z.number().nullable(),
    /** Read-time classification of `sentiment_score`; null exactly when it is. */
    sentiment_band: sentimentBandSchema.nullable(),
    /** Read-time `confidenceFor(cells_30d)`; null when cells_30d is null — nothing measured yet. */
    confidence: confidenceSchema.nullable(),
    /** Per-engine, cells-weighted visibility over the current window, sorted by score desc. Null with no per-engine data. */
    engine_scores: z.array(projectEngineScoreSchema).nullable(),
    /** The denormalised 30-day series the matrix draws without a per-project query. */
    sparkline_30d: z.unknown().nullable(),
    /** STORY-169 — true only for the dev-only demo seed's rows. Never true on data the real pipeline produced. */
    demo_seeded: z.boolean(),
    /**
     * STORY-175 - the latest capture run. Always emitted (null = never scanned); OPTIONAL in the schema so
     * publishing it is the additive change `contracts:diff` rates minor, not a new required field (major).
     */
    last_scan: lastScanSchema.nullable().optional(),
  })
  .strict();

export const projectListResponseSchema = z.array(projectListItemSchema);

export type LastScan = z.infer<typeof lastScanSchema>;
export type ProjectListItem = z.infer<typeof projectListItemSchema>;

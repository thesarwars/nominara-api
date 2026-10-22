import { z } from "zod";
import { paginationRequestSchema } from "../common/pagination.schema.js";
import { goalMetricSchema } from "./create-goal-request.schema.js";

// STORY-065 (step A) — one goal on the wire.
//
// PROGRESS IS THREE NUMBERS, NOT A PERCENTAGE: `baseline`, `current` and
// `target.target_value` are all present on every read, so the claim is
// checkable. `progress_pct` is the stored value; it is `null` — never 0 —
// when `sample_state` is `insufficient` (precision theatre otherwise). A
// null `value` inside baseline/current is "not measured", never 0.
//
// `current` is written by the rollup step (`refreshProjectGoals`); a read never
// recomputes it. At creation it equals the baseline snapshot. `status`
// `achieved` and `achieved_at` are set by that same step, never by a request.
export const goalKindSchema = z.enum([
  "prompt_recommendation",
  "engine_score",
  "topic_authority",
  "citation_presence",
  "rendering_quality",
  "sentiment_recovery",
  "custom",
]);

export const goalStatusSchema = z.enum(["active", "achieved", "abandoned"]);
export const goalSampleStateSchema = z.enum(["sufficient", "insufficient"]);

export const goalMeasurementSchema = z
  .object({
    value: z.number().nullable(),
    /** n = cells behind the value (scoring-models.md confidence band); null = unknown. */
    cells: z.number().int().nullable(),
    at: z.string(),
  })
  .strict();

export const goalDirectionSchema = z.enum(["up", "down"]);

/**
 * `direction` is DERIVED BY THE SERVER AT CREATION and stored here: `up` when the target is at or above the baseline, `down`
 * when below. It decides what "reaching the target" means (a value at or above it, or at or below it) and which way progress
 * runs. Absent on a goal created before it existed, which reads as `up`.
 */
export const goalTargetSchema = z
  .object({
    metric: goalMetricSchema,
    target_value: z.number(),
    direction: goalDirectionSchema.optional(),
    engine_key: z.string().optional(),
    prompt_cluster_id: z.string().uuid().optional(),
  })
  .strict();

export const goalSchema = z
  .object({
    id: z.string().uuid(),
    project_id: z.string().uuid(),
    title: z.string(),
    kind: goalKindSchema,
    target: goalTargetSchema,
    baseline: goalMeasurementSchema.nullable(),
    current: goalMeasurementSchema.nullable(),
    progress_pct: z.number().nullable(),
    sample_state: goalSampleStateSchema,
    status: goalStatusSchema,
    target_date: z.string().nullable(),
    achieved_at: z.string().nullable(),
    tasks_done: z.number().int(),
    tasks_total: z.number().int(),
    created_at: z.string(),
  })
  .strict();

export type Goal = z.infer<typeof goalSchema>;

// Decision 2026-10-09 pm #3 — the cursor envelope; `pagination` is published by the route's `listOf` marker.
export const goalListQuerySchema = paginationRequestSchema;
export type GoalListQuery = z.infer<typeof goalListQuerySchema>;

export const goalListResponseSchema = z.array(goalSchema);
export type GoalListResponse = z.infer<typeof goalListResponseSchema>;

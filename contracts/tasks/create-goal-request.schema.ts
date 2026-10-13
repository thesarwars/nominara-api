import { z } from "zod";
import { lowercaseUuidSchema } from "../common/uuid.schema.js";

// STORY-065 (step A) — POST /v1/projects/{id}/goals.
//
// schemas/tasks-and-goals.md `goals`: a goal has a kind and a target
// `{metric, target_value, engine_key?, prompt_cluster_id?}`. The baseline is
// NEVER accepted from the caller: the server captures it at creation, from the
// measured value, so "before" cannot be typed in.
//
// KINDS SUPPORTED THIS WEEK: only the two whose baseline has a stored,
// measured source — `engine_score` (projects.visibility_blended) and
// `topic_authority` (topic_clusters.visibility_score, which needs a
// `prompt_cluster_id`). The other five kinds in the table's CHECK have no
// stored baseline source yet and are a 400 here rather than a goal with a
// made-up before. `engine_key` is not accepted for the same reason (no
// per-engine baseline is read). `.strict()`: an unknown key is a 400.
export const GOAL_TITLE_MAX = 200;

export const goalCreatableKindSchema = z.enum(["engine_score", "topic_authority"]);
export const goalMetricSchema = z.enum(["visibility_score"]);

export const goalTargetRequestSchema = z
  .object({
    metric: goalMetricSchema,
    /** 0..100 — the Visibility Score scale. */
    target_value: z.number().min(0).max(100),
    /** Required for `topic_authority`, forbidden for `engine_score` (checked below). */
    prompt_cluster_id: lowercaseUuidSchema.optional(),
  })
  .strict();

export const createGoalRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(GOAL_TITLE_MAX),
    kind: goalCreatableKindSchema,
    target: goalTargetRequestSchema,
    /** ISO date (YYYY-MM-DD). */
    target_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasCluster = value.target.prompt_cluster_id !== undefined;
    if (value.kind === "topic_authority" && !hasCluster) {
      ctx.addIssue({ code: "custom", path: ["target", "prompt_cluster_id"], message: "required for a topic_authority goal" });
    }
    if (value.kind === "engine_score" && hasCluster) {
      ctx.addIssue({ code: "custom", path: ["target", "prompt_cluster_id"], message: "not allowed for an engine_score goal" });
    }
  });

export type CreateGoalRequest = z.infer<typeof createGoalRequestSchema>;

// PATCH /v1/projects/{id}/goals/{goalId} — the only transition a caller makes
// is abandonment ("requires no reason but is audited"). `achieved` is set by
// the rollup, never by a request.
export const updateGoalRequestSchema = z.object({ status: z.literal("abandoned") }).strict();
export type UpdateGoalRequest = z.infer<typeof updateGoalRequestSchema>;

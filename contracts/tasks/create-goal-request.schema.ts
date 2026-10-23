import { z } from "zod";
import { lowercaseUuidSchema } from "../common/uuid.schema.js";

// STORY-065 — POST /v1/projects/{id}/goals.
//
// schemas/tasks-and-goals.md `goals`: a goal has a kind and a target
// `{metric, target_value, engine_key?, prompt_cluster_id?}`. The baseline is
// NEVER accepted from the caller: the server captures it at creation, from the
// measured value, so "before" cannot be typed in. Neither is `direction`: the
// server takes it from the metric (`GOAL_METRIC_DIRECTION`, always `up`) and stores
// it in the target (see `goalTargetSchema`), never from baseline versus target.
//
// ONE METRIC PER KIND (planner recommendation, STORY-065 plan). A kind names the
// question; the metric is the stored, measured number that answers it, and the
// request must name exactly that metric (a mismatch is a 400, never a silent
// substitution):
//
//   engine_score          visibility_score   projects.visibility_blended (project), or one engine's metric_daily row
//   topic_authority       visibility_score   topic_clusters.visibility_score        (needs prompt_cluster_id)
//   citation_presence     citation_share     metric_daily.citation_share
//   rendering_quality     rendering_quality  projects.rendering_quality / metric_daily.rendering_quality
//   sentiment_recovery    sentiment_score    metric_daily.sentiment_score (null with no mentions: insufficient, never 50)
//   prompt_recommendation presence_rate      prompt_stability over the cluster's prompts (needs prompt_cluster_id)
//
// EVERY `target_value` IS ON A 0-100 SCALE. `citation_share` and `presence_rate` are stored as fractions; a goal states and
// reads them as percentages so the three numbers (baseline, current, target) are always comparable.
//
// `custom` IS STILL REFUSED (a 400): it has no measured source, and a goal with a typed-in "current" would break "the baseline is
// never typed in". It becomes creatable when a metric source for it exists. `engine_key` scopes a goal to one engine's rows where
// a per-engine source exists (not `topic_authority`: a cluster's score has no engine split). `.strict()`: an unknown key is a 400.
export const GOAL_TITLE_MAX = 200;

export const goalCreatableKindSchema = z.enum([
  "prompt_recommendation",
  "engine_score",
  "topic_authority",
  "citation_presence",
  "rendering_quality",
  "sentiment_recovery",
]);
export type GoalCreatableKind = z.infer<typeof goalCreatableKindSchema>;

export const goalMetricSchema = z.enum(["visibility_score", "citation_share", "rendering_quality", "sentiment_score", "presence_rate"]);
export type GoalMetric = z.infer<typeof goalMetricSchema>;

/** The one metric each creatable kind measures. */
export const GOAL_KIND_METRIC: Readonly<Record<GoalCreatableKind, GoalMetric>> = {
  engine_score: "visibility_score",
  topic_authority: "visibility_score",
  citation_presence: "citation_share",
  rendering_quality: "rendering_quality",
  sentiment_recovery: "sentiment_score",
  prompt_recommendation: "presence_rate",
};

/** Kinds that are measured over one topic cluster, and so require `prompt_cluster_id`. */
export const GOAL_CLUSTER_KINDS: readonly GoalCreatableKind[] = ["topic_authority", "prompt_recommendation"];
/** Kinds that accept an `engine_key` scope. */
export const GOAL_ENGINE_KINDS: readonly GoalCreatableKind[] = ["engine_score", "citation_presence", "rendering_quality", "sentiment_recovery", "prompt_recommendation"];

export const goalTargetRequestSchema = z
  .object({
    metric: goalMetricSchema,
    /** 0..100 — every goal metric is stated on the Visibility Score scale (shares and rates as percentages). */
    target_value: z.number().min(0).max(100),
    /** One engine's rows. Allowed for the kinds in `GOAL_ENGINE_KINDS`; the engine must exist (checked by the service). */
    engine_key: z.string().regex(/^[a-z0-9_]{1,64}$/u).optional(),
    /** Required for `topic_authority` and `prompt_recommendation`, refused for the rest (checked below). */
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
    if (value.target.metric !== GOAL_KIND_METRIC[value.kind]) {
      ctx.addIssue({ code: "custom", path: ["target", "metric"], message: `a ${value.kind} goal measures ${GOAL_KIND_METRIC[value.kind]}` });
    }
    const needsCluster = GOAL_CLUSTER_KINDS.includes(value.kind);
    const hasCluster = value.target.prompt_cluster_id !== undefined;
    if (needsCluster && !hasCluster) {
      ctx.addIssue({ code: "custom", path: ["target", "prompt_cluster_id"], message: `required for a ${value.kind} goal` });
    }
    if (!needsCluster && hasCluster) {
      ctx.addIssue({ code: "custom", path: ["target", "prompt_cluster_id"], message: `not allowed for a ${value.kind} goal` });
    }
    if (value.target.engine_key !== undefined && !GOAL_ENGINE_KINDS.includes(value.kind)) {
      ctx.addIssue({ code: "custom", path: ["target", "engine_key"], message: `not allowed for a ${value.kind} goal` });
    }
  });

export type CreateGoalRequest = z.infer<typeof createGoalRequestSchema>;

// PATCH /v1/projects/{id}/goals/{goalId} — the only transition a caller makes
// is abandonment ("requires no reason but is audited"). `achieved` is set by
// the rollup, never by a request.
export const updateGoalRequestSchema = z.object({ status: z.literal("abandoned") }).strict();
export type UpdateGoalRequest = z.infer<typeof updateGoalRequestSchema>;

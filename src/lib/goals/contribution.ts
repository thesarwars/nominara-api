import type { GoalMetric } from "../../../contracts/tasks/index.js";

// STORY-065 AC4/AC5 — which task rules feed which goal metric. This is what makes the contribution ordering "relative to the
// goal's metric": inside a goal, a task whose rule feeds the goal's metric comes before one whose rule does not, whatever their
// absolute impact (a high-impact audit finding on an unrelated page is important, and is not progress toward "be recommended
// for this topic").
//
// TIERED, NOT WEIGHTED (planner recommendation): relevant first (impact order), then everything else (impact order). It is
// deterministic and explainable — a customer can be told exactly why a task sits where it does — and a weight such as 0.1 would
// be a number nobody could defend.
//
// THE TABLE IS A JUDGEMENT, KEYED BY `task_generation_rules.trigger_kind` (the rule's metric family; the closed `condition`
// grammar's own `metric` names a measurement, not the goal it moves). It is conservative: a trigger is listed only where the
// rule's own subject IS the goal's metric or directly moves it. A task with no rule (manual, command bar) has no metric and so
// is never relevant. Edit this table, with the story, to change what ranks first; nothing else encodes it.
export const GOAL_METRIC_TRIGGERS: Readonly<Record<GoalMetric, readonly string[]>> = {
  visibility_score: ["sov_drop", "presence_loss", "competitor_gain", "displacement", "topic_gap"],
  citation_share: ["citation_gap", "source_absence", "displacement"],
  presence_rate: ["presence_loss", "prompt_unstable", "topic_gap"],
  sentiment_score: ["sentiment_negative"],
  rendering_quality: ["render_downgrade", "schema_missing", "aux_finding"],
};

/**
 * The SQL expression that is true for a goal-linked task that contributes to its goal. Reads `g` (the task's goal) and `r` (its
 * rule, LEFT JOINed, null for a rule-less task) and `t`. A NULL result (no rule, no goal) is "not relevant" to the CASE that uses it.
 *
 * SCOPE. A dimension the goal does not name is not a constraint. A dimension it does name is met by a task that names the same
 * value OR names none: an engine-less task is project-wide (it affects every engine), and a cluster-less task is project-wide
 * (it affects every cluster). A task scoped to a DIFFERENT engine or cluster does not contribute.
 *
 * Static SQL assembled from the constants above — no request value is ever interpolated.
 */
export const GOAL_CONTRIBUTES_SQL = ((): string => {
  const quoted = (triggers: readonly string[]): string => `ARRAY[${triggers.map((trigger) => `'${trigger}'`).join(", ")}]::text[]`;
  const arms = (Object.keys(GOAL_METRIC_TRIGGERS) as GoalMetric[])
    .map((metric) => `WHEN '${metric}' THEN ${quoted(GOAL_METRIC_TRIGGERS[metric])}`)
    .join(" ");
  return (
    `(t.goal_id IS NOT NULL ` +
    `AND r.trigger_kind = ANY(CASE g.target->>'metric' ${arms} ELSE ARRAY[]::text[] END) ` +
    `AND (g.target->>'engine_key' IS NULL OR cardinality(t.affected_engines) = 0 OR (g.target->>'engine_key') = ANY(t.affected_engines)) ` +
    `AND (g.target->>'prompt_cluster_id' IS NULL OR t.prompt_cluster_id IS NULL OR t.prompt_cluster_id::text = g.target->>'prompt_cluster_id'))`
  );
})();

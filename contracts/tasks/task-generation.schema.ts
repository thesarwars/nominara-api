import { z } from "zod";

// STORY-063 — the shapes behind the three jsonb columns the task generation engine owns.
//
// `task_generation_rules.condition` is a CLOSED, zod-validated grammar: each member names a predicate TEMPLATE the
// evaluator knows how to compile to parameterised SQL, and carries only numbers and enum members. It never carries SQL
// text — a rule stored as SQL in jsonb would be an injection and tenancy-bypass vector (the evaluator runs under the
// job's tenant context, and RLS is only a guarantee while the statement is ours). A rule tuned by ops UPDATE can change
// a threshold, a window or a sample floor; it cannot change what the evaluator executes.
//
// Every member is strict, so an unknown key is a parse failure and the rule is skipped (fail closed), not half-applied.

export const TASK_METRIC_WINDOW_METRICS = ["sov", "presence_rate", "owned_citation_count", "negative_mention_rate"] as const;
export const taskMetricWindowMetricSchema = z.enum(TASK_METRIC_WINDOW_METRICS);

/**
 * A sustained change of a brand metric over `window_days` versus the `window_days` before it (scoring-models.md §15:
 * "a sustained relative change across a window versus the prior window, n >= 30"). `min_n` applies to BOTH windows.
 * `change` is the unit of `threshold`: a fraction of the prior value (`relative`) or a difference in the metric's own
 * unit (`absolute`). `min_current` is an optional floor on the current value (`negative_spike`).
 */
export const metricWindowConditionSchema = z
  .object({
    kind: z.literal("metric_window"),
    metric: taskMetricWindowMetricSchema,
    direction: z.enum(["down", "up"]),
    change: z.enum(["relative", "absolute"]),
    threshold: z.number().positive().finite(),
    window_days: z.number().int().min(1).max(90),
    min_n: z.number().int().min(1),
    /** `each_engine`: one candidate per engine. `across_engines`: one project-wide candidate when >= `min_engines` engines moved. */
    engine_scope: z.enum(["each_engine", "across_engines"]),
    min_engines: z.number().int().min(1).max(10).optional(),
    min_current: z.number().min(0).finite().optional(),
  })
  .strict();

/** A tracked competitor's Visibility Score crossing above the brand's, windowed against the prior window. */
export const competitorOvertakeConditionSchema = z
  .object({
    kind: z.literal("competitor_overtake"),
    window_days: z.number().int().min(1).max(90),
    min_n: z.number().int().min(1),
  })
  .strict();

/** A displacement event of this workspace-local day whose impact score is at least `min_impact` (0..100). */
export const displacementConditionSchema = z
  .object({
    kind: z.literal("displacement"),
    min_impact: z.number().min(0).max(100),
  })
  .strict();

/** A finding of AUX rule `aux_rule_code`, first detected (or regressed) on the evaluated day, at one of `severities`. */
export const auxFindingConditionSchema = z
  .object({
    kind: z.literal("aux_finding"),
    aux_rule_code: z.string().regex(/^AUX-R-\d{3}$/u),
    severities: z.array(z.enum(["critical", "high", "medium", "low", "info"])).min(1),
  })
  .strict();

/** A domain at one of `gap_severities` on the project's index row (engine `all`, `window_days`), seedable in the workspace. */
export const sourceGapConditionSchema = z
  .object({
    kind: z.literal("source_gap"),
    gap_severities: z.array(z.enum(["critical", "high"])).min(1),
    window_days: z.number().int().min(1).max(365),
  })
  .strict();

/** At least `min_prompts` active priority prompts with a stability score below `max_stability`. */
export const promptStabilityConditionSchema = z
  .object({
    kind: z.literal("prompt_stability"),
    max_stability: z.number().min(0).max(1),
    min_prompts: z.number().int().min(1),
  })
  .strict();

/**
 * A rule whose facts come from an analysis that has not shipped yet (topic gap, divergence, entity node, rendering
 * downgrade). The evaluator generates NOTHING for it, and says so on a metric — a rule enabled before its analysis
 * exists must fail closed, not guess.
 */
export const pendingAnalysisConditionSchema = z
  .object({
    kind: z.literal("pending_analysis"),
    analysis: z.enum(["topic_gap", "divergence", "entity_node", "render_downgrade"]),
  })
  .strict();

export const taskGenerationConditionSchema = z.discriminatedUnion("kind", [
  metricWindowConditionSchema,
  competitorOvertakeConditionSchema,
  displacementConditionSchema,
  auxFindingConditionSchema,
  sourceGapConditionSchema,
  promptStabilityConditionSchema,
  pendingAnalysisConditionSchema,
]);
export type TaskGenerationCondition = z.infer<typeof taskGenerationConditionSchema>;
export type MetricWindowCondition = z.infer<typeof metricWindowConditionSchema>;

/**
 * `tasks.baseline_metrics` — captured AT CREATION (schemas/tasks-and-goals.md). A metric that had no data is `null`,
 * never `0`: zero share of voice and "not measured" are different facts and the verification run must tell them apart.
 */
export const taskBaselineMetricsSchema = z
  .object({
    captured_at: z.string().datetime(),
    metric_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    window_days: z.number().int().min(1),
    engine_key: z.string(),
    cells_total: z.number().int().min(0),
    sov: z.number().nullable(),
    presence_rate: z.number().nullable(),
    visibility_score: z.number().nullable(),
    owned_citation_count: z.number().int().nullable(),
  })
  .strict();
export type TaskBaselineMetrics = z.infer<typeof taskBaselineMetricsSchema>;

/**
 * `tasks.playbook_payload` for an authority task. `quoted_rules` and `contribution_outline` stay empty until the
 * playbook content ships (STORY-055); they are present and empty rather than invented. Nominara never posts for the
 * customer, so `do_not` always says so.
 */
export const taskPlaybookPayloadSchema = z
  .object({
    target_url: z.string().nullable(),
    target_domain: z.string(),
    angle: z.string(),
    quoted_rules: z.array(z.string()),
    contribution_outline: z.array(z.string()),
    disclosure_required: z.boolean(),
    do_not: z.array(z.string()).min(1),
  })
  .strict();
export type TaskPlaybookPayload = z.infer<typeof taskPlaybookPayloadSchema>;

/** The payload of an `evidence_refreshed` task event: what the recurrence saw, not engine text. */
export const taskEvidenceRefreshPayloadSchema = z
  .object({
    metric_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    recurrence_count: z.number().int().min(1),
    impact_score: z.number().min(0).max(100),
    affected_engines: z.array(z.string()),
  })
  .strict();
export type TaskEvidenceRefreshPayload = z.infer<typeof taskEvidenceRefreshPayloadSchema>;

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

// `negative_cell_rate` (scoring-models.md §6/§15: cells with ANY negative mention over cells) is NOT here: metric_daily
// holds no negative-cell count, and `mentions_negative / mentions_total` is the other §6 formula, not the alert's. The
// rule is seeded as a `pending_analysis` until the count exists.
export const TASK_METRIC_WINDOW_METRICS = ["sov", "presence_rate", "owned_citation_count"] as const;

/** The reference's floor on a sample (scoring-models.md §15: n >= 30). A tuned rule cannot go below it. */
export const TASK_MIN_SAMPLE = 30;
export const taskMetricWindowMetricSchema = z.enum(TASK_METRIC_WINDOW_METRICS);

/**
 * A sustained change of a brand metric over `window_days` versus the `window_days` before it (scoring-models.md §15:
 * "a sustained relative change across a window versus the prior window, n >= 30"). `min_n` applies to BOTH windows.
 * `change` is the unit of `threshold`: a fraction of the prior value (`relative`) or a difference in the metric's own
 * unit (`absolute`).
 *
 * "SUSTAINED" IS A PROPERTY OF THE GRAMMAR, not of the window aggregate, and it is measured over the capture RUNS that exist in the
 * window (cadence is plan-driven: daily, twice weekly, weekly), not over calendar days or metric dates (one run can straddle local
 * midnight). A run belongs to exactly ONE window, the one holding its earliest local capture date. The window itself comes from the
 * plan's cadence data (`engines.cadence_by_plan`): `window_days` for a cadence with two runs in it, a whole multiple of it for a
 * slower one (a weekly cadence compares 14 days with the 14 before when `window_days` is 7). The change needs two or more runs in the
 * current window and must ALSO hold, against the prior window's value, on at least `min(sustained_days, runs_in_window)` distinct
 * runs, each on a day carrying at least `ceil(min_n / window)` cells (the day floor: a blip cannot pad the count around one heavy
 * day). Every metric is a rate per measured cell, a count included (`owned_citation_count`).
 * A window-wide sum alone lets one very heavy bad day carry the aggregate; this does not. `sustained_days` is at least 2 and
 * `min_n` at least 30, so an ops UPDATE can tune a threshold but cannot tune the hysteresis away.
 */
export const metricWindowConditionSchema = z
  .object({
    kind: z.literal("metric_window"),
    metric: taskMetricWindowMetricSchema,
    direction: z.enum(["down", "up"]),
    change: z.enum(["relative", "absolute"]),
    threshold: z.number().positive().finite(),
    window_days: z.number().int().min(1).max(90),
    min_n: z.number().int().min(TASK_MIN_SAMPLE),
    sustained_days: z.number().int().min(2).max(90),
    /** `each_engine`: one candidate per engine. `across_engines`: one project-wide candidate when >= `min_engines` engines moved. */
    engine_scope: z.enum(["each_engine", "across_engines"]),
    min_engines: z.number().int().min(1).max(10).optional(),
  })
  .strict()
  .refine((condition) => condition.sustained_days <= condition.window_days, { message: "sustained_days cannot exceed window_days", path: ["sustained_days"] });

/** A tracked competitor's Visibility Score crossing above the brand's, windowed against the prior window. */
export const competitorOvertakeConditionSchema = z
  .object({
    kind: z.literal("competitor_overtake"),
    window_days: z.number().int().min(1).max(90),
    /** Applies to the brand's AND the competitor's windows, in both periods. */
    min_n: z.number().int().min(TASK_MIN_SAMPLE),
  })
  .strict();

/** A displacement event not yet planned (no task), detected since the rule was enabled, whose impact score is at least `min_impact` (0..100). */
export const displacementConditionSchema = z
  .object({
    kind: z.literal("displacement"),
    min_impact: z.number().min(0).max(100),
  })
  .strict();

/** An open or regressed finding of AUX rule `aux_rule_code` at one of `severities`, with no task yet for its current detection. */
export const auxFindingConditionSchema = z
  .object({
    kind: z.literal("aux_finding"),
    aux_rule_code: z.string().regex(/^AUX-R-\d{3}$/u),
    severities: z.array(z.enum(["critical", "high", "medium", "low", "info"])).min(1),
  })
  .strict();

/**
 * A domain whose latest index row (engine `all`, the WIDEST window — the one every authority path reads, STORY-054 AC10)
 * has moved INTO one of `gap_severities`, seedable in the workspace. "A new critical gap": a gap that was already at that
 * severity on the previous row does not generate again. The window is not tunable here, so this rule cannot disagree with
 * the recovery plan about which domains are actionable.
 */
export const sourceGapConditionSchema = z
  .object({
    kind: z.literal("source_gap"),
    gap_severities: z.array(z.enum(["critical", "high"])).min(1),
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
    analysis: z.enum(["topic_gap", "divergence", "entity_node", "render_downgrade", "negative_cell_rate"]),
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
    /** Set when the recurrence is a further displacement event on the same task (a second loss on one domain). */
    source_displacement_id: z.string().uuid().optional(),
  })
  .strict();
export type TaskEvidenceRefreshPayload = z.infer<typeof taskEvidenceRefreshPayloadSchema>;

import type { ClientBase } from "pg";
import {
  taskGenerationConditionSchema,
  type MetricWindowCondition,
  type TaskGenerationCondition,
} from "../../../contracts/tasks/index.js";
import { citationGapSchema } from "../../../contracts/analytics/index.js";
import { actionableAuthorityDomains, authorityTargets, authorityTaskFingerprint } from "../analytics/displacement-recovery.js";
import { SOURCE_INDEX_WINDOWS } from "../rollup/refresh-project-source-index.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { compileMetricWindow, effectiveWindowDays, runFloorCells } from "./compile.js";
import { taskFingerprint } from "./fingerprint.js";
import { strengthOf } from "./impact.js";
import type { EvalContext, RuleRow, TaskDraft } from "./types.js";

// STORY-063 — one evaluator per condition template. Each reads FACTS (metric_daily, displacement_events, aux_findings,
// project_source_index, tracked_prompts) inside the job's tenant transaction and returns drafts; it never writes. Every
// statement is static SQL with bound parameters — the stored condition supplies numbers and enum members only.

/** The widest source-index window: the one an authority task is gated on (STORY-054 AC10). */
const AUTHORITY_WINDOW_DAYS = Math.max(...SOURCE_INDEX_WINDOWS);

/**
 * How far back, from the evaluated day, an unplanned displacement is still picked up. Planning is gated on the event not
 * having a task, never on its detection DAY: `detected_at` is the wall-clock time the rollup ran, so it can fall on a later
 * day than the facts it belongs to (a run captured at 23:50 and parsed after midnight, a dirty-date reprocess), and a
 * day-equality filter would lose those events without trace.
 */
export const DISPLACEMENT_LOOKBACK_DAYS = 30;

/** The rule kinds whose condition is a function of the evaluated DAY's windows. Event and state kinds gate on `enabled_since` instead. */
export const WINDOWED_KINDS: ReadonlySet<TaskGenerationCondition["kind"]> = new Set(["metric_window", "competitor_overtake"]);

/** Parses a stored condition. `undefined` is "this rule is not usable": the caller skips it and counts it (fail closed). */
export function parseCondition(rule: Pick<RuleRow, "code" | "condition">): TaskGenerationCondition | undefined {
  const parsed = taskGenerationConditionSchema.safeParse(rule.condition);
  return parsed.success ? parsed.data : undefined;
}

export async function evaluateRule(rule: RuleRow, condition: TaskGenerationCondition, ctx: EvalContext): Promise<TaskDraft[]> {
  switch (condition.kind) {
    case "metric_window":
      return evaluateMetricWindow(rule, condition, ctx);
    case "competitor_overtake":
      return evaluateCompetitorOvertake(rule, condition, ctx);
    case "displacement":
      return evaluateDisplacement(rule, condition, ctx);
    case "aux_finding":
      return evaluateAuxFinding(rule, condition, ctx);
    case "source_gap":
      return evaluateSourceGap(rule, condition, ctx);
    case "prompt_stability":
      return evaluatePromptStability(rule, condition, ctx);
    case "pending_analysis":
      // The analysis this rule reads does not exist yet (D2/D4). Nothing is generated, and it is counted: a rule enabled
      // before its facts exist must be visible, not silently inert.
      incrementCounter("nominara_taskgen_rules_pending_analysis_total", { analysis: condition.analysis });
      return [];
  }
}

// ---- metric_window ---------------------------------------------------------------------------------------------------

interface MetricWindowRow {
  engine_key: string;
  n_current: number;
  n_prior: number;
  cur_value: number;
  prior_value: number;
  change_value: number;
}

/** `change_value` as the number a title shows: percent for a relative change, points for an absolute change of a rate (every metric is a rate per measured cell). */
function changeText(change: number): number {
  return Math.round(change * 100 * 10) / 10;
}

async function evaluateMetricWindow(rule: RuleRow, condition: MetricWindowCondition, ctx: EvalContext): Promise<TaskDraft[]> {
  // The window per engine comes from the plan's cadence (`cadence_by_plan`, through the entitled-engines view the scheduler also reads).
  const cadence = await ctx.tx.query<{ engine_key: string; cadence: unknown }>(`SELECT engine_key, cadence FROM project_entitled_engines WHERE project_id = $1::uuid`, [ctx.projectId]);
  const engineWindowDays = Object.fromEntries(cadence.rows.map((row) => [row.engine_key, effectiveWindowDays(condition.window_days, row.cadence)]));
  const engineRunFloor = Object.fromEntries(cadence.rows.map((row) => [row.engine_key, runFloorCells(condition.min_n, engineWindowDays[row.engine_key]!, row.cadence)]));
  const compiled = compileMetricWindow(condition, {
    projectId: ctx.projectId, metricDate: ctx.metricDate, scoringVersion: ctx.scoringVersion, timezone: ctx.timezone, engineWindowDays, engineRunFloor,
  });
  /** The window an engine was actually compared over: the title names it, so a Starter task says 14 days, not the rule's 7. */
  const windowOf = (engine: string): number => engineWindowDays[engine] ?? condition.window_days;
  const rows = (await ctx.tx.query<MetricWindowRow>(compiled.text, [...compiled.values])).rows;

  if (condition.engine_scope === "each_engine") {
    return rows.map((row) => ({
      fingerprint: taskFingerprint(rule.code, ctx.projectId, row.engine_key),
      vars: { engine: row.engine_key, change_pct: changeText(row.change_value), window_days: windowOf(row.engine_key) },
      strength: strengthOf(row.change_value, condition.threshold),
      baselineEngine: row.engine_key,
      affectedEngines: [row.engine_key],
      affectedPromptIds: [],
    }));
  }

  const minEngines = condition.min_engines ?? 3;
  if (rows.length < minEngines) return [];
  const smallest = Math.min(...rows.map((row) => row.change_value));
  const mean = rows.reduce((sum, row) => sum + row.change_value, 0) / rows.length;
  return [
    {
      fingerprint: taskFingerprint(rule.code, ctx.projectId, "project"),
      // "at least": the smallest of the engines' changes, so the title never overstates the drop.
      vars: { engine_count: rows.length, change_pct: changeText(smallest), window_days: Math.max(...rows.map((row) => windowOf(row.engine_key))) },
      strength: strengthOf(mean, condition.threshold),
      baselineEngine: "all",
      affectedEngines: rows.map((row) => row.engine_key),
      affectedPromptIds: [],
    },
  ];
}

// ---- competitor_overtake ---------------------------------------------------------------------------------------------

async function evaluateCompetitorOvertake(
  rule: RuleRow,
  condition: Extract<TaskGenerationCondition, { kind: "competitor_overtake" }>,
  ctx: EvalContext,
): Promise<TaskDraft[]> {
  // Both entities' windows are weighted by their cells (an unweighted mean of daily scores lets a one-cell day count as much as a
  // full one) and BOTH the brand's and the competitor's windows must meet the sample floor in both periods.
  const result = await ctx.tx.query<{ entity_id: string; name: string | null; gap: number }>(
    `WITH w AS (
       SELECT entity_type, entity_id,
              (metric_date > $2::date - $3::int) AS is_current,
              (sum(visibility_score * cells_total) / NULLIF(sum(cells_total) FILTER (WHERE visibility_score IS NOT NULL), 0))::float8 AS vis,
              (sum(cells_total) FILTER (WHERE visibility_score IS NOT NULL))::float8 AS cells
         FROM metric_daily
        WHERE project_id = $1::uuid AND engine_key = 'all' AND scoring_version = $4
          AND metric_date >  $2::date - 2 * $3::int
          AND metric_date <= $2::date
        GROUP BY entity_type, entity_id, is_current
     )
     SELECT cc.entity_id, k.name, (cc.vis - bc.vis) AS gap
       FROM w bc
       JOIN w bp ON bp.entity_type = 'brand' AND bp.entity_id = bc.entity_id AND NOT bp.is_current
       JOIN w cc ON cc.entity_type = 'competitor' AND cc.is_current
       JOIN w cp ON cp.entity_type = 'competitor' AND cp.entity_id = cc.entity_id AND NOT cp.is_current
       LEFT JOIN competitors k ON k.id = cc.entity_id
      WHERE bc.entity_type = 'brand' AND bc.is_current
        AND bc.cells >= $5::float8 AND bp.cells >= $5::float8
        AND cc.cells >= $5::float8 AND cp.cells >= $5::float8
        AND cc.vis > bc.vis
        AND cp.vis <= bp.vis
      ORDER BY cc.entity_id`,
    [ctx.projectId, ctx.metricDate, condition.window_days, ctx.scoringVersion, condition.min_n],
  );
  return result.rows.map((row) => ({
    fingerprint: taskFingerprint(rule.code, ctx.projectId, `competitor:${row.entity_id}`),
    vars: { competitor: row.name ?? "A competitor", window_days: condition.window_days },
    // The crossing has no threshold; a gap of 10 Visibility Score points is the 0.5 mark, 20 or more is full strength.
    strength: strengthOf(row.gap, 10),
    baselineEngine: "all",
    affectedEngines: [],
    affectedPromptIds: [],
  }));
}

// ---- displacement ----------------------------------------------------------------------------------------------------

async function evaluateDisplacement(
  rule: RuleRow,
  condition: Extract<TaskGenerationCondition, { kind: "displacement" }>,
  ctx: EvalContext,
): Promise<TaskDraft[]> {
  // Events not yet planned (`task_id IS NULL`), detected since the rule was (re-)enabled, inside a bounded lookback. NOT the
  // evaluated day: see DISPLACEMENT_LOOKBACK_DAYS. `task_id` is what makes any reprocess of any date a no-op, and the
  // `enabled_since` TIMESTAMP is what keeps a re-enabled rule from reaching back into the period it was off.
  //
  // TODO(STORY-058): a displacement's concept gap should yield one CONTENT task per concept (scoring-models.md §15,
  // TG-DISPLACEMENT-RECOVER). `concept_gap` is always [] until the concept analysis ships, so only authority tasks exist.
  const events = await ctx.tx.query<{ id: string; engine_key: string; prompt_id: string; impact: number; citation_gap: unknown }>(
    `SELECT id, engine_key, prompt_id, impact_score::float8 AS impact, citation_gap
       FROM displacement_events
      WHERE project_id = $1::uuid
        AND task_id IS NULL AND recovered_at IS NULL AND dismissed_at IS NULL
        AND impact_score >= $2::real
        AND ($3::timestamptz IS NULL OR detected_at >= $3::timestamptz)
        AND detected_at >= (($4::date - $5::int)::timestamp AT TIME ZONE $6::text)
      ORDER BY detected_at, id`,
    [ctx.projectId, condition.min_impact, rule.enabled_since, ctx.metricDate, DISPLACEMENT_LOOKBACK_DAYS, ctx.timezone],
  );

  const drafts: TaskDraft[] = [];
  for (const event of events.rows) {
    const parsed = citationGapSchema.safeParse(event.citation_gap);
    if (!parsed.success) {
      incrementCounter("nominara_taskgen_displacement_gap_invalid_total");
      continue;
    }
    const gap = parsed.data;
    const domains = [...new Set(gap.map((entry) => entry.domain.toLowerCase()))];
    const seedable = await actionableAuthorityDomains(ctx.tx, ctx.workspaceId, ctx.projectId, domains, AUTHORITY_WINDOW_DAYS);
    const slugs = await playbookSlugs(ctx.tx, [...seedable.values()]);
    for (const entry of authorityTargets(gap, new Set(seedable.keys()))) {
      const domain = entry.domain.toLowerCase();
      const domainId = seedable.get(domain) ?? null;
      drafts.push({
        // The recovery plan's own fingerprint: the rule path and the on-demand path collapse into one task per domain.
        fingerprint: authorityTaskFingerprint(ctx.projectId, domain),
        kind: "authority",
        vars: { domain },
        strength: Math.min(1, Math.max(0, event.impact / 100)),
        baselineEngine: event.engine_key,
        affectedEngines: [event.engine_key],
        affectedPromptIds: [event.prompt_id],
        sourceDisplacementId: event.id,
        sourceDomainId: domainId,
        affectedUrl: entry.url,
        playbook: { slug: domainId === null ? null : (slugs.get(domainId) ?? null), domain, url: entry.url, angle: "displacement_recovery" },
        displacementId: event.id,
        noCooldown: true,
      });
    }
  }
  return drafts;
}

// ---- aux_finding -----------------------------------------------------------------------------------------------------

const SEVERITY_STRENGTH: Readonly<Record<string, number>> = { critical: 1, high: 0.75, medium: 0.5, low: 0.25, info: 0.1 };

async function evaluateAuxFinding(rule: RuleRow, condition: Extract<TaskGenerationCondition, { kind: "aux_finding" }>, ctx: EvalContext): Promise<TaskDraft[]> {
  // An open or regressed finding with NO task yet for its current detection (a task created since it was first detected or last
  // regressed), detected since the rule was enabled. Not the evaluated day: an audit can finish after the day's last rollup, or
  // on a day no rollup runs, and a same-day filter would never turn that finding into a task.
  const found = await ctx.tx.query<{
    id: string;
    fingerprint: Buffer;
    title: string;
    url: string | null;
    severity: string;
    detected_at: Date;
    regressed_at: Date | null;
  }>(
    `SELECT f.id, f.fingerprint, f.title, f.url, f.severity, GREATEST(f.first_detected_at, f.regressed_at) AS detected_at, f.regressed_at
       FROM aux_findings f
      WHERE f.project_id = $1::uuid AND f.rule_code = $2 AND f.severity = ANY($3::text[])
        AND f.status IN ('open', 'regressed')
        AND ($4::timestamptz IS NULL OR GREATEST(f.first_detected_at, f.regressed_at) >= $4::timestamptz)
        AND NOT EXISTS (
          SELECT 1 FROM tasks t
           WHERE t.source_finding_id = f.id AND t.deleted_at IS NULL
             AND (t.created_at >= GREATEST(f.first_detected_at, f.regressed_at)
                  -- A regression that an OPEN task already absorbed is counted once. "Absorbed" is a WALL-CLOCK fact — the
                  -- recurrence event was written after the regression — never the task's last_evidence_at, which is the END of
                  -- the evaluated day (a future instant when that day is today) and would swallow a regression the same day.
                  -- Whatever became of the task since (completed, say) the event still says this regression was counted, so it
                  -- is NOT counted again. No status test: a regression AFTER the completion has a later regressed_at than
                  -- every event on the task, so it is still new work.
                  OR EXISTS (
                        SELECT 1 FROM task_events e
                         WHERE e.task_id = t.id AND e.event = 'evidence_refreshed' AND e.occurred_at >= f.regressed_at))
        )
      ORDER BY f.first_detected_at, f.id`,
    [ctx.projectId, condition.aux_rule_code, condition.severities, rule.enabled_since],
  );
  const drafted = found.rows.map((row) => ({ row, fingerprint: taskFingerprint(rule.code, ctx.projectId, Buffer.from(row.fingerprint).toString("hex")) }));
  // The task the dedupe lands on is found by FINGERPRINT, and its `source_finding_id` can be gone; absorb through it too.
  const absorbed = await absorbedByFingerprint(
    ctx,
    drafted.map(({ row, fingerprint }) => ({ fingerprint, createdSince: row.detected_at, eventSince: row.regressed_at })),
  );
  return drafted.filter(({ fingerprint }) => !absorbed.has(fingerprint.toString("hex"))).map(({ row, fingerprint }) => ({
    fingerprint,
    vars: { finding_title: row.title, aux_rule_code: condition.aux_rule_code },
    strength: SEVERITY_STRENGTH[row.severity] ?? 0.5,
    baselineEngine: "all",
    affectedEngines: [],
    affectedPromptIds: [],
    sourceFindingId: row.id,
    affectedUrl: row.url,
    // A regression is a discrete event: it counts on the open task once, even on the day the task was last refreshed.
    discrete: true,
  }));
}

// ---- source_gap ------------------------------------------------------------------------------------------------------

async function evaluateSourceGap(
  rule: RuleRow,
  condition: Extract<TaskGenerationCondition, { kind: "source_gap" }>,
  ctx: EvalContext,
): Promise<TaskDraft[]> {
  // The ONE actionable-domain predicate (latest row, widest window, seedable) the recovery plan reads, so the two paths cannot
  // disagree; THEN the rule's own question: is this a NEW critical gap?
  //
  // "New" is judged on what the production writer keeps. `refreshProjectSourceIndex` DELETEs and re-inserts the project's rows on
  // every rollup (a new `window_start` and `computed_at` each time), so neither a previous row nor `computed_at` survives a day.
  // What it DOES carry across a recompute is the verified presence, and a critical gap exists only through it (an unverified
  // domain has no severity): `verified_at` moves when the gap is re-confirmed by a fetch, and only then. A gap is new when it
  // was verified after the last task for the domain was made; an open task for an older verification is refreshed ONCE (the
  // recurrence event is the witness), not on every rollup.
  const actionable = await actionableAuthorityDomains(ctx.tx, ctx.workspaceId, ctx.projectId, null, AUTHORITY_WINDOW_DAYS);
  if (actionable.size === 0) return [];
  const found = await ctx.tx.query<{ id: string; domain: string; gap_severity: string; seeding_playbook_slug: string | null; verified_at: Date }>(
    `WITH ranked AS (
       SELECT psi.source_domain_id, psi.gap_severity, psi.verified_at,
              row_number() OVER (PARTITION BY psi.source_domain_id ORDER BY psi.window_start DESC) AS rn
         FROM project_source_index psi
        WHERE psi.project_id = $1::uuid AND psi.engine_key = 'all' AND psi.window_days = $2::int
          AND psi.source_domain_id = ANY($3::uuid[])
     )
     SELECT sd.id, lower(sd.domain) AS domain, r.gap_severity, sd.seeding_playbook_slug, r.verified_at
       FROM ranked r
       JOIN source_domains sd ON sd.id = r.source_domain_id
      WHERE r.rn = 1
        AND r.gap_severity = ANY($4::text[])
        AND r.verified_at IS NOT NULL
        AND ($5::timestamptz IS NULL OR r.verified_at >= $5::timestamptz)
        AND NOT EXISTS (
          SELECT 1 FROM tasks t
           WHERE t.project_id = $1::uuid AND t.source_domain_id = sd.id AND t.deleted_at IS NULL
             AND (t.created_at >= r.verified_at
                  -- No status test: a refresh counted this verification whatever became of the task since, and a completed task
                  -- makes nothing new until the gap is verified AGAIN (a later verified_at than every event).
                  OR EXISTS (
                        SELECT 1 FROM task_events e
                         WHERE e.task_id = t.id AND e.event = 'evidence_refreshed' AND e.occurred_at >= r.verified_at))
        )
      ORDER BY lower(sd.domain)`,
    [ctx.projectId, AUTHORITY_WINDOW_DAYS, [...actionable.values()], condition.gap_severities, rule.enabled_since],
  );
  const drafted = found.rows.map((row) => ({ row, fingerprint: authorityTaskFingerprint(ctx.projectId, row.domain) }));
  const absorbed = await absorbedByFingerprint(
    ctx,
    drafted.map(({ row, fingerprint }) => ({ fingerprint, createdSince: row.verified_at, eventSince: row.verified_at })),
  );
  return drafted.filter(({ fingerprint }) => !absorbed.has(fingerprint.toString("hex"))).map(({ row, fingerprint }) => ({
    // Shared with the recovery plan and the displacement rule: one authority task per project and domain.
    fingerprint,
    kind: "authority" as const,
    vars: { domain: row.domain },
    strength: SEVERITY_STRENGTH[row.gap_severity] ?? 0.5,
    baselineEngine: "all",
    affectedEngines: [],
    affectedPromptIds: [],
    sourceDomainId: row.id,
    playbook: { slug: row.seeding_playbook_slug, domain: row.domain, url: null, angle: "source_gap" },
    discrete: true,
  }));
}

// ---- prompt_stability ------------------------------------------------------------------------------------------------

async function evaluatePromptStability(rule: RuleRow, condition: Extract<TaskGenerationCondition, { kind: "prompt_stability" }>, ctx: EvalContext): Promise<TaskDraft[]> {
  const found = await ctx.tx.query<{ id: string }>(
    `SELECT id FROM tracked_prompts
      WHERE project_id = $1::uuid AND is_priority AND status = 'active' AND deleted_at IS NULL
        AND stability_score IS NOT NULL AND stability_score < $2::real
      ORDER BY id`,
    [ctx.projectId, condition.max_stability],
  );
  if (found.rows.length < condition.min_prompts) return [];
  return [
    {
      fingerprint: taskFingerprint(rule.code, ctx.projectId, "project"),
      vars: { prompt_count: found.rows.length, max_stability: condition.max_stability },
      strength: strengthOf(found.rows.length, condition.min_prompts),
      baselineEngine: "all",
      affectedEngines: [],
      affectedPromptIds: found.rows.map((row) => row.id),
    },
  ];
}

/**
 * A discrete event's absorption, by the key the task service dedupes on. The id-keyed predicates in the queries above
 * (`source_finding_id`, `source_domain_id`) stop matching if that link is ever NULLed (ON DELETE SET NULL, or a task made without
 * it); the fingerprint is what `createGeneratedTask` lands on, so the two must agree or a discrete refresh would count again on
 * every run. A candidate is absorbed when a task (any status, not deleted) under its fingerprint was created at or after
 * `createdSince`, or has an `evidence_refreshed` event at or after `eventSince` (a null bound never matches). Returns hex fingerprints.
 */
async function absorbedByFingerprint(
  ctx: EvalContext,
  items: ReadonlyArray<{ fingerprint: Buffer; createdSince: Date | null; eventSince: Date | null }>,
): Promise<Set<string>> {
  if (items.length === 0) return new Set();
  const result = await ctx.tx.query<{ fp: string }>(
    `SELECT c.fp
       FROM unnest($2::text[], $3::timestamptz[], $4::timestamptz[]) AS c(fp, created_since, event_since)
      WHERE EXISTS (
        SELECT 1 FROM tasks t
         WHERE t.project_id = $1::uuid AND t.deleted_at IS NULL AND t.dedupe_fingerprint = decode(c.fp, 'hex')
           AND (t.created_at >= c.created_since
                OR EXISTS (SELECT 1 FROM task_events e
                            WHERE e.task_id = t.id AND e.event = 'evidence_refreshed' AND e.occurred_at >= c.event_since)))`,
    [ctx.projectId, items.map((item) => item.fingerprint.toString("hex")), items.map((item) => item.createdSince), items.map((item) => item.eventSince)],
  );
  return new Set(result.rows.map((row) => row.fp));
}

async function playbookSlugs(tx: ClientBase, domainIds: readonly string[]): Promise<Map<string, string | null>> {
  const slugs = new Map<string, string | null>();
  if (domainIds.length === 0) return slugs;
  const rows = await tx.query<{ id: string; seeding_playbook_slug: string | null }>(
    `SELECT id, seeding_playbook_slug FROM source_domains WHERE id = ANY($1::uuid[])`,
    [[...domainIds]],
  );
  for (const row of rows.rows) slugs.set(row.id, row.seeding_playbook_slug);
  return slugs;
}

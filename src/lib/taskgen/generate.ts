import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase } from "pg";
import { taskPlaybookPayloadSchema, type TaskBaselineMetrics } from "../../../contracts/tasks/index.js";
import type { TasksService, GeneratedTaskInput } from "../../modules/tasks/tasks.service.js";
import { SCORING_VERSION } from "../scoring/index.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
import { captureBaseline } from "./baseline.js";
import { linkDisplacementToTask } from "../analytics/displacement-recovery.js";
import { evaluateRule, parseCondition, WINDOWED_KINDS } from "./evaluate.js";
import { impactScore } from "./impact.js";
import { renderTemplate } from "./template.js";
import type { EvalContext, RuleRow, TaskDraft } from "./types.js";

// STORY-063 — the task generation engine: evaluates the enabled rule catalog against one project's facts for one
// workspace-local day and turns what fires into tasks, through the ONE task-insert path (TasksService).
//
// IDEMPOTENT, because the rollup re-runs on dirty dates: a task's fingerprint dedupes it while it is open, evidence that is
// not newer than the task's own `last_evidence_at` writes nothing, and a displacement is linked to its task so the same
// event is never planned twice. Running this five times for one day leaves the task count AND the recurrence counter alone.
//
// HYSTERESIS lives in the conditions (a window versus the prior window, a sample floor on both) and in the cooldown the
// task service applies; the displacement rule is exempt from the cooldown by design.
//
// FAIL CLOSED: a rule whose condition does not parse is skipped and counted; a rule for an analysis that does not exist
// generates nothing. Nothing here makes a network call (KAD-06) — it reads this database only.

const logger = new Logger("taskgen");
const tracer = trace.getTracer("nominara-api");

export interface GenerateRequest {
  readonly projectId: string;
  /** `YYYY-MM-DD`, workspace-local: the day whose facts are evaluated. */
  readonly metricDate: string;
  /** Restrict to rules of these `trigger_kind`s (a producer that only knows one kind of change, e.g. a new AUX finding). */
  readonly triggerKinds?: readonly string[];
}

/**
 * STORY-068 — one draft the evaluation acted on, handed to the alert catalog so an alert is raised from the SAME
 * evaluation that made (or refreshed, deduplicated or suppressed) its task: one evaluator, never a second one.
 */
export interface FiredDraft {
  readonly ruleCode: string;
  readonly draft: TaskDraft;
  readonly taskId: string;
  readonly title: string;
  readonly description: string;
}

export interface GenerationHooks {
  readonly onFired?: (fired: FiredDraft) => void;
}

export interface GenerationSummary {
  rulesEvaluated: number;
  rulesSkipped: number;
  created: number;
  refreshed: number;
  deduplicated: number;
  suppressed: number;
}

const DO_NOT: readonly string[] = [
  "Post, publish or submit anything on the customer's behalf: Nominara never does, and the customer acts under their own account.",
  "Contribute without the disclosure the platform requires.",
];

export async function generateTasksForProject(tx: ClientBase, tasks: TasksService, request: GenerateRequest, hooks: GenerationHooks = {}): Promise<GenerationSummary> {
  return tracer.startActiveSpan("taskgen.evaluate", async (span) => {
    try {
      const summary = await generate(tx, tasks, request, hooks);
      span.setAttribute("nominara.taskgen.rules_evaluated", summary.rulesEvaluated);
      span.setAttribute("nominara.taskgen.tasks_created", summary.created);
      return summary;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

async function generate(tx: ClientBase, tasks: TasksService, request: GenerateRequest, hooks: GenerationHooks): Promise<GenerationSummary> {
  const summary: GenerationSummary = { rulesEvaluated: 0, rulesSkipped: 0, created: 0, refreshed: 0, deduplicated: 0, suppressed: 0 };

  // Under RLS another tenant's project is simply absent: nothing is read and nothing is written for it.
  const project = await tx.query<{ workspace_id: string; timezone: string }>(
    `SELECT p.workspace_id, w.timezone
       FROM projects p JOIN workspaces w ON w.id = p.workspace_id
      WHERE p.id = $1 AND p.deleted_at IS NULL`,
    [request.projectId],
  );
  const found = project.rows[0];
  if (found === undefined) return summary;

  const rules = await tx.query<RuleRow>(
    `SELECT code, category, title_template, description_template, trigger_kind, condition, default_priority,
            impact_weight::float8 AS impact_weight, effort_band, opens_alignment, playbook_slug, cooldown_days,
            (enabled_since AT TIME ZONE $1)::date::text AS enabled_since_date, enabled_since
       FROM task_generation_rules
      WHERE enabled AND ($2::text[] IS NULL OR trigger_kind = ANY($2::text[]))
      ORDER BY code`,
    [found.timezone, request.triggerKinds === undefined ? null : [...request.triggerKinds]],
  );

  const evidenceAt = (
    await tx.query<{ at: Date }>(`SELECT (($1::date + 1)::timestamp AT TIME ZONE $2) AS at`, [request.metricDate, found.timezone])
  ).rows[0]!.at;
  const ctx: EvalContext = {
    tx,
    workspaceId: found.workspace_id,
    projectId: request.projectId,
    metricDate: request.metricDate,
    timezone: found.timezone,
    scoringVersion: SCORING_VERSION,
  };
  const baselines = new Map<string, TaskBaselineMetrics>();

  for (const rule of rules.rows) {
    const condition = parseCondition(rule);
    if (condition === undefined) {
      // A half-valid rule is never half-applied.
      incrementCounter("nominara_taskgen_rules_invalid_total");
      logger.warn({ message: "task generation rule skipped: condition does not parse", workspace_id: found.workspace_id, rule_code: rule.code });
      summary.rulesSkipped += 1;
      continue;
    }
    // AC13 — non-retroactive re-enable. A rule over a day's WINDOWS skips a day before it was last switched back on; an event or
    // state rule (a displacement, an AUX finding, a source gap) gates on the `enabled_since` TIMESTAMP inside its own query,
    // because the event's own time, not the day being evaluated, says whether it belongs to the period the rule was off.
    if (WINDOWED_KINDS.has(condition.kind) && rule.enabled_since_date !== null && request.metricDate < rule.enabled_since_date) {
      incrementCounter("nominara_taskgen_rules_skipped_total", { reason: "before_enabled_since" });
      summary.rulesSkipped += 1;
      continue;
    }

    summary.rulesEvaluated += 1;
    incrementCounter("nominara_taskgen_rules_evaluated_total", { trigger_kind: rule.trigger_kind });
    for (const draft of await evaluateRule(rule, condition, ctx)) {
      const input = await toTaskInput(tx, rule, draft, ctx, evidenceAt, baselines);
      const result = await tasks.createGeneratedTask(input);
      summary[result.outcome === "created" ? "created" : result.outcome] += 1;
      hooks.onFired?.({ ruleCode: rule.code, draft, taskId: result.task.id, title: input.title, description: input.description });
      incrementCounter("nominara_taskgen_tasks_total", { outcome: result.outcome });
      if (draft.displacementId !== undefined && result.outcome !== "suppressed") {
        // The displacement points at its task, so it is planned once. The first task wins and is never replaced.
        await linkDisplacementToTask(tx, ctx.workspaceId, draft.displacementId, result.task.id);
      }
    }
  }

  const workspaceId = currentTenantStore()?.context.workspaceId ?? found.workspace_id;
  logger.log({
    message: "task generation complete",
    workspace_id: workspaceId,
    project_id: request.projectId,
    metric_date: request.metricDate,
    rules_evaluated: summary.rulesEvaluated,
    rules_skipped: summary.rulesSkipped,
    created: summary.created,
    refreshed: summary.refreshed,
    deduplicated: summary.deduplicated,
    suppressed: summary.suppressed,
  });
  return summary;
}

async function toTaskInput(
  tx: ClientBase,
  rule: RuleRow,
  draft: TaskDraft,
  ctx: EvalContext,
  evidenceAt: Date,
  baselines: Map<string, TaskBaselineMetrics>,
): Promise<GeneratedTaskInput> {
  const kind = draft.kind ?? rule.category;
  const score = impactScore(rule.impact_weight, draft.strength);
  // One baseline per engine per run: it is a read of the same facts, and it is only PERSISTED when the task is created.
  let baseline = baselines.get(draft.baselineEngine);
  if (baseline === undefined) {
    baseline = await captureBaseline(tx, ctx.projectId, ctx.metricDate, draft.baselineEngine, ctx.scoringVersion);
    baselines.set(draft.baselineEngine, baseline);
  }
  const playbookSlug = kind === "authority" ? (draft.playbook?.slug ?? rule.playbook_slug) : null;
  const playbookPayload =
    kind === "authority" && draft.playbook !== undefined
      ? taskPlaybookPayloadSchema.parse({
          target_url: draft.playbook.url,
          target_domain: draft.playbook.domain,
          angle: draft.playbook.angle,
          quoted_rules: [],
          contribution_outline: [],
          disclosure_required: true,
          do_not: [...DO_NOT],
        })
      : null;

  // AC12 (alignment-session reference on content tasks that would benefit) is DEFERRED, not met: there is no `alignment_sessions`
  // table yet, so `rule.opens_alignment` is read but `tasks.alignment_session_id` is never written. The only rules that set
  // `opens_alignment` (TG-ENTITY-NODE, TG-TOPIC-CONTENT) are `pending_analysis` and disabled, so no such task exists today.
  // Revisit when the alignment-session story ships.
  return {
    projectId: ctx.projectId,
    kind,
    origin: "auto",
    ruleCode: rule.code,
    fingerprint: draft.fingerprint,
    title: renderTemplate(rule.title_template, draft.vars),
    description: renderTemplate(rule.description_template, draft.vars),
    sourceDisplacementId: draft.sourceDisplacementId ?? null,
    sourceDomainId: draft.sourceDomainId ?? null,
    affectedUrl: draft.affectedUrl ?? null,
    generation: {
      sourceFindingId: draft.sourceFindingId ?? null,
      sourceGeoAnalysis: draft.sourceGeoAnalysis ?? null,
      affectedEngines: draft.affectedEngines,
      affectedPromptIds: draft.affectedPromptIds,
      playbookSlug,
      playbookPayload,
      baselineMetrics: baseline,
      impactScore: score,
      effortBand: rule.effort_band,
      priority: rule.default_priority,
      evidenceAt,
      systemActor: true,
    },
    cooldownDays: draft.noCooldown === true ? 0 : rule.cooldown_days,
    refresh: {
      evidenceAt,
      metricDate: ctx.metricDate,
      impactScore: score,
      affectedEngines: draft.affectedEngines,
      affectedPromptIds: draft.affectedPromptIds,
      // A displacement is a discrete event consumed exactly once (it is linked to its task straight after), so a SECOND loss on
      // a domain that already has an open task is a recurrence even on the same metric day.
      ...(draft.displacementId === undefined ? {} : { sourceDisplacementId: draft.displacementId }),
      ...(draft.discrete === true ? { discreteEvent: true } : {}),
    },
  };
}

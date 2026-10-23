import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase } from "pg";
import type { GoalMetric } from "../../../contracts/tasks/index.js";
import { AuditChainService } from "../../modules/audit/audit-chain.service.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { uuidV7 } from "../ids/uuidv7.js";
import { SCORING_VERSION } from "../scoring/index.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { AGGREGATE_ATTRIBUTE_CAPABLE_ENGINES } from "./aggregate-day.js";
import { CROSS_ENGINE_KEY } from "./roll-up-day.js";

// STORY-065 AC2 / AC6 / AC11 — the goal refresh: what a goal measures, how far it has moved, and whether it has arrived.
//
// "Progress refresh happens in the rollup, not on read." `GoalsService` never recomputes; `current` and `progress_pct` change
// ONLY here, and `achieved` is set ONLY here. This is a rollup STEP, written like `refreshProjectTaskCounts`: it takes the
// tenant transaction the rollup already holds and reads only this database (no network call).
//
// Called by the rollup handler (`queue/handlers/rollup-metric-daily.handler.ts`) after `denormalizeProject`, whose figures the
// goals read, inside the same tenant transaction and project lock.
//
// ONE SOURCE PER METRIC, all STORED figures (the same ones the dashboard reads), each with the CELL COUNT behind it so a
// goal can say "not enough data" instead of a number (`GOAL_MIN_CELLS`, scoring-models.md confidence band). A value that is
// absent is `null`, never 0: an unmeasured metric is not a zero score.

const tracer = trace.getTracer("nominara.goals-refresh");
const logger = new Logger("goals.refresh");

/** scoring-models.md "Confidence band": `low` when n < 30. A goal under this many cells (or unmeasured) is `insufficient`. */
export const GOAL_MIN_CELLS = 30;
/** The window the cell count covers, ending at the latest measured day (`denormalize.ts`'s own 30-day window). */
const WINDOW_DAYS = 30;

export interface GoalMeasurement {
  readonly value: number | null;
  readonly cells: number | null;
}

/** What a goal needs in order to be measured. `target` is the stored jsonb, so every member is optional here. */
export interface GoalSubject {
  readonly kind: string;
  readonly target: {
    readonly metric?: GoalMetric | undefined;
    readonly engine_key?: string | undefined;
    readonly prompt_cluster_id?: string | undefined;
  };
}

/**
 * The current value of a goal's metric and the n behind it. THE ONE FUNCTION creation and the refresh share, so "baseline" and
 * "current" are the same measurement taken at two times.
 *
 *  - `topic_authority`   topic_clusters.visibility_score. A cluster has no cell count of its own and the project's n is NOT
 *                        the cluster's, so `cells` is null (insufficient) until a cluster-level n exists.
 *  - `prompt_recommendation`  presence over the cluster's live prompts from `prompt_stability`: the latest window per prompt
 *                        and engine, weighted by its sample count, as a percentage. `cells` is the summed sample count.
 *  - an engine scope     that engine's `metric_daily` brand rows: the latest day's value, the 30-day cell count. For
 *                        `sentiment_score` (here and project-wide, on the `all` row) the n is the latest day's MENTION count.
 *  - otherwise           the project's denormalised figure (`visibility_blended`, `rendering_quality`) with
 *                        its own n, or the cross-engine (`all`) `metric_daily` row for `citation_share`.
 *
 * Shares and rates are stored as fractions and read as percentages (every goal value is on a 0-100 scale), rounded to 3 places.
 */
export async function measureGoal(tx: ClientBase, projectId: string, goal: GoalSubject): Promise<GoalMeasurement> {
  const metric = goal.target.metric;
  const engineKey = goal.target.engine_key ?? null;

  if (goal.kind === "topic_authority") {
    const cluster = await tx.query<{ value: number | null }>(
      `SELECT visibility_score::float8 AS value FROM topic_clusters WHERE id = $1 AND project_id = $2`,
      [goal.target.prompt_cluster_id ?? null, projectId],
    );
    return { value: cluster.rows[0]?.value ?? null, cells: null };
  }

  if (goal.kind === "prompt_recommendation") {
    const presence = await tx.query<{ value: number | null; cells: number | null }>(
      `WITH latest AS (
         SELECT DISTINCT ON (ps.prompt_id, ps.engine_key) ps.presence_rate::float8 AS presence_rate, ps.sample_count
           FROM prompt_stability ps
           JOIN tracked_prompts tp ON tp.id = ps.prompt_id
          WHERE tp.project_id = $1 AND tp.cluster_id = $2 AND tp.deleted_at IS NULL AND tp.superseded_by IS NULL
            AND ($3::text IS NULL OR ps.engine_key = $3)
          ORDER BY ps.prompt_id, ps.engine_key, ps.window_start DESC
       )
       SELECT CASE WHEN sum(sample_count) > 0
                   THEN round((sum(presence_rate * sample_count) / sum(sample_count) * 100)::numeric, 3)::float8 END AS value,
              sum(sample_count)::int AS cells
         FROM latest`,
      [projectId, goal.target.prompt_cluster_id ?? null, engineKey],
    );
    return { value: presence.rows[0]?.value ?? null, cells: presence.rows[0]?.cells ?? null };
  }

  if (metric === undefined) return { value: null, cells: null };

  if (engineKey !== null || metric === "citation_share" || metric === "sentiment_score") {
    return engineWindow(tx, projectId, engineKey ?? CROSS_ENGINE_KEY, metric);
  }

  if (metric === "rendering_quality") {
    // The figure rests on the attribute-capable engines' cells only (`denormalize.ts`, STORY-169 re-audit): the project's overall
    // n would put a confident n behind a number that rests on far fewer cells.
    const rendering = await tx.query<{ value: number | null; cells: number | null }>(
      `SELECT (SELECT rendering_quality::float8 FROM projects WHERE id = $1) AS value,
              (SELECT sum(md.cells_total)::int
                 FROM metric_daily md
                WHERE md.project_id = $1 AND md.engine_key = ANY($2::text[]) AND md.entity_type = 'brand' AND md.scoring_version = $3
                  AND md.metric_date > (SELECT max(m2.metric_date) FROM metric_daily m2
                                         WHERE m2.project_id = $1 AND m2.engine_key = ANY($2::text[]) AND m2.entity_type = 'brand' AND m2.scoring_version = $3)
                                       - ${String(WINDOW_DAYS)}) AS cells`,
      [projectId, AGGREGATE_ATTRIBUTE_CAPABLE_ENGINES, SCORING_VERSION],
    );
    return { value: rendering.rows[0]?.value ?? null, cells: rendering.rows[0]?.cells ?? null };
  }

  // engine_score, project-wide: the denormalised block and its own n.
  const project = await tx.query<{ value: number | null; cells: number | null }>(
    `SELECT CASE $2 WHEN 'visibility_score' THEN visibility_blended::float8 END AS value,
            cells_30d AS cells
       FROM projects WHERE id = $1`,
    [projectId, metric],
  );
  return { value: project.rows[0]?.value ?? null, cells: project.rows[0]?.cells ?? null };
}

/** One engine's latest-day value of `metric` and its 30-day cell count (null when the engine has no rows). Static SQL. */
async function engineWindow(tx: ClientBase, projectId: string, engineKey: string, metric: GoalMetric): Promise<GoalMeasurement> {
  const result = await tx.query<{ value: number | null; cells: number | null }>(
    `WITH latest AS (
       SELECT max(metric_date) AS d FROM metric_daily
        WHERE project_id = $1 AND engine_key = $2 AND entity_type = 'brand' AND scoring_version = $3
     )
     SELECT (SELECT CASE $4
                      WHEN 'visibility_score'   THEN md.visibility_score::float8
                      WHEN 'citation_share'     THEN round(md.citation_share::numeric * 100, 3)::float8
                      WHEN 'rendering_quality'  THEN md.rendering_quality::float8
                      WHEN 'sentiment_score'    THEN md.sentiment_score::float8
                    END
               FROM metric_daily md, latest
              WHERE md.project_id = $1 AND md.engine_key = $2 AND md.entity_type = 'brand' AND md.scoring_version = $3
                AND md.metric_date = latest.d) AS value,
            CASE WHEN $4 = 'sentiment_score'
                 -- Sentiment is computed from MENTIONS only (scoring/aggregate.ts), so the n behind it is the mention count, on the
                 -- SAME day as the value; the cell count says nothing about how many mentions the figure rests on.
                 THEN (SELECT md.mentions_total
                         FROM metric_daily md, latest
                        WHERE md.project_id = $1 AND md.engine_key = $2 AND md.entity_type = 'brand' AND md.scoring_version = $3
                          AND md.metric_date = latest.d)
                 ELSE (SELECT sum(md.cells_total)::int
                         FROM metric_daily md, latest
                        WHERE md.project_id = $1 AND md.engine_key = $2 AND md.entity_type = 'brand' AND md.scoring_version = $3
                          AND md.metric_date > latest.d - ${String(WINDOW_DAYS)})
            END AS cells`,
    [projectId, engineKey, SCORING_VERSION, metric],
  );
  return { value: result.rows[0]?.value ?? null, cells: result.rows[0]?.cells ?? null };
}

/** Which way a metric must move to reach its target. */
export type GoalDirection = "up" | "down";

/**
 * Direction is a property of the METRIC, not of where a goal happened to start. Every goal metric today is higher-is-better
 * (visibility_score, citation_share, rendering_quality, sentiment_score, presence_rate), so there is no `down` entry: a target typed
 * below a noisy baseline must never turn into a goal that is "achieved" by the metric getting WORSE, and the record of
 * achievement is the strongest reporting artifact. A lower-is-better metric earns its entry here when one exists.
 */
export const GOAL_METRIC_DIRECTION: Readonly<Record<GoalMetric, GoalDirection>> = {
  visibility_score: "up",
  citation_share: "up",
  rendering_quality: "up",
  sentiment_score: "up",
  presence_rate: "up",
};

/** The direction of a goal's metric (`up` when the target carries none, which no creatable goal does). */
export function goalDirectionOf(metric: GoalMetric | undefined): GoalDirection {
  return metric === undefined ? "up" : GOAL_METRIC_DIRECTION[metric];
}

/** A baseline the creation check may rely on: measured, on at least `GOAL_MIN_CELLS` cells. */
export function isSufficientMeasurement(measured: GoalMeasurement): boolean {
  return measured.value !== null && measured.cells !== null && measured.cells >= GOAL_MIN_CELLS;
}

/** Reaching the target is inclusive: at it, or beyond it in the goal's direction. */
export function goalReached(direction: GoalDirection, current: number, targetValue: number): boolean {
  return direction === "up" ? current >= targetValue : current <= targetValue;
}

/**
 * How far `current` has moved from `baseline` toward the target, 0..100, 2 places. Clamped: a regression past the baseline is 0, not
 * negative, and an overshoot is 100. Null when there is no baseline to measure from. A zero span (baseline equals target) is 100
 * once reached and 0 before.
 */
export function goalProgressPct(direction: GoalDirection, baseline: number | null, current: number, targetValue: number): number | null {
  if (baseline === null) return null;
  const span = direction === "up" ? targetValue - baseline : baseline - targetValue;
  const moved = direction === "up" ? current - baseline : baseline - current;
  if (span <= 0) return goalReached(direction, current, targetValue) ? 100 : 0;
  return Math.round(Math.min(100, Math.max(0, (moved / span) * 100)) * 100) / 100;
}

export interface GoalsRefreshResult {
  /** Active goals whose `current` was re-measured. */
  readonly refreshed: number;
  /** The goals this pass moved to `achieved`. */
  readonly achieved: readonly string[];
}

interface ActiveGoalRow {
  id: string;
  workspace_id: string;
  kind: string;
  target: GoalSubject["target"] & { target_value: number };
  baseline: { value: number | null } | null;
}

/**
 * Re-measures every ACTIVE goal of a project, in the caller's tenant transaction.
 *
 * `current` and `progress_pct` are rewritten; an `achieved` goal is a RECORD and is never touched again (not re-stamped, not
 * re-measured, not re-audited), and neither is an abandoned one — so a second pass over the same state is a no-op.
 *
 * ACHIEVEMENT needs a SUFFICIENT sample: a value past the target on fewer than `GOAL_MIN_CELLS` cells, or unmeasured, is not an
 * achievement (precision theatre in the other direction). It sets `status`, `achieved_at` and writes one `goal.achieved` audit row
 * as the SYSTEM actor, in the same transaction — no worker has a user. While a sample is insufficient `progress_pct` is left as it
 * was (a read masks it to null) and `current` still moves, so the customer sees the n.
 *
 * `FOR UPDATE`: a user abandoning the goal at the same moment serialises with the refresh, and whichever commits first wins
 * cleanly (an abandoned goal is no longer `active` by the time the refresh locks it, and is skipped).
 */
export async function refreshProjectGoals(tx: ClientBase, projectId: string): Promise<GoalsRefreshResult> {
  return tracer.startActiveSpan("goals.refresh", async (span) => {
    try {
      const goals = await tx.query<ActiveGoalRow>(
        `SELECT id, workspace_id, kind, target, baseline FROM goals WHERE project_id = $1 AND status = 'active' ORDER BY created_at, id FOR UPDATE`,
        [projectId],
      );
      const achieved: string[] = [];
      for (const goal of goals.rows) {
        const measured = await measureGoal(tx, projectId, goal);
        const direction = goalDirectionOf(goal.target.metric);
        const sufficient = isSufficientMeasurement(measured);
        const reached = sufficient && goalReached(direction, measured.value as number, goal.target.target_value);
        const progress = sufficient ? goalProgressPct(direction, goal.baseline?.value ?? null, measured.value as number, goal.target.target_value) : null;
        const snapshot = { value: measured.value, cells: measured.cells, at: new Date().toISOString() };
        await tx.query(
          `UPDATE goals
              SET current = $2::jsonb,
                  progress_pct = COALESCE($3::numeric, progress_pct),
                  status = CASE WHEN $4::boolean THEN 'achieved' ELSE status END,
                  achieved_at = CASE WHEN $4::boolean THEN now() ELSE achieved_at END,
                  updated_at = now()
            WHERE id = $1`,
          [goal.id, JSON.stringify(snapshot), reached ? 100 : progress, reached],
        );
        if (reached) {
          achieved.push(goal.id);
          // The controller's @Audit does not exist on a worker path, so the row is written here, on the SAME chained writer and
          // INSIDE the transaction: an achievement with no audit row rolls back. Metric and ids only — never the title.
          await new AuditChainService().append(tx, {
            workspaceId: goal.workspace_id,
            actorType: "system",
            actorId: SYSTEM_ACTOR_ID,
            actorIp: null,
            actorUa: "worker:goals.refresh",
            action: "goal.achieved",
            resourceType: "goal",
            resourceId: goal.id,
            beforeState: { status: "active" },
            afterState: { status: "achieved", metric: goal.target.metric ?? null, value: measured.value, target_value: goal.target.target_value },
            requestId: `goals.refresh:${uuidV7()}`,
            supportGrantId: null,
            severity: "info",
          });
          incrementCounter("nominara_goals_achieved_total", { kind: goal.kind });
        }
      }
      incrementCounter("nominara_goals_refreshed_total");
      span.setAttribute("nominara.goals_refresh.refreshed", goals.rows.length);
      span.setAttribute("nominara.goals_refresh.achieved", achieved.length);
      // Project ID and counts only — never a goal title.
      logger.log({ event: "goals.refresh.run", project_id: projectId, refreshed: goals.rows.length, achieved: achieved.length });
      return { refreshed: goals.rows.length, achieved };
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

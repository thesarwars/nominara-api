import { Injectable } from "@nestjs/common";
import type { ClientBase } from "pg";
import type { ScorecardsQuery, ScorecardsResponse, ScorecardEntry } from "../../../contracts/analytics/index.js";
import { NotFoundError } from "../../api/errors/domain-errors.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
import {
  blendScorecards,
  EMPTY_WINDOW_METRICS,
  toScorecard,
  toWindowMetrics,
  type Scorecard,
  type WindowMetrics,
} from "../../lib/analytics/scorecard.js";
import { aggregateRange } from "../../lib/rollup/aggregate-day.js";
import { SCORING_VERSION } from "../../lib/scoring/index.js";

// STORY-136 — `GET /v1/projects/{id}/scorecards`.
//
// Every figure on the Project Overview screen, from one request. The
// arithmetic lives in `src/lib/analytics/scorecard.ts`; this resolves the
// window, reads the facts, and joins the engine configuration onto them.

const TIMEFRAME_DAYS: Readonly<Record<ScorecardsQuery["timeframe"], number>> = Object.freeze({
  "7d": 7,
  "30d": 30,
  "90d": 90,
});

interface EngineConfig {
  engine_key: string;
  display_name: string | null;
  cadenceRunsPerCycle: number | null;
  weight: number;
  /** Not windowed — see the contract. */
  lastCapturedAt: Date | null;
}

/**
 * §5's cadence is stated in runs per 30-day cycle, so the interval between
 * two runs is `30 days / runs` — the same arithmetic `resolveDueEngines`
 * does. Duplicated as a constant rather than imported so this read does not
 * pull the scheduler's query into an analytics request; the value is §5's,
 * not either module's, and `engine-cadence.ts` asserts it against the same
 * section.
 */
const CYCLE_MS = 30 * 24 * 60 * 60 * 1000;

interface ResolvedWindow {
  from: string;
  to: string;
  priorFrom: string;
  priorTo: string;
  timezone: string;
}

@Injectable()
export class ScorecardsService {
  async scorecards(projectId: string, query: ScorecardsQuery): Promise<ScorecardsResponse> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("ScorecardsService requires an active tenant context");
    const tx = store.client;

    const window = await this.resolveWindow(tx, projectId, TIMEFRAME_DAYS[query.timeframe]);
    const requested = query.engines?.split(",").map((key) => key.trim()).filter((key) => key.length > 0) ?? null;
    const engines = await this.engineConfig(tx, projectId, requested);

    // TWO RANGE AGGREGATIONS, not 2 × N. `aggregateRange` groups by engine, so
    // the whole window costs one scan per period however many engines the
    // project has.
    const [current, prior] = await Promise.all([
      this.brandMetricsByEngine(tx, projectId, window.from, window.to, window.timezone),
      this.brandMetricsByEngine(tx, projectId, window.priorFrom, window.priorTo, window.timezone),
    ]);

    // AN ENABLED ENGINE WITH NO ROWS IS STILL AN ENTRY. Omitting it would
    // read as "not enabled", where the truth is "enabled and never measured"
    // — the same distinction the matrix draws between its five cell states.
    const entries = engines.map((engine) => ({
      engine,
      scorecard: toScorecard(
        engine.engine_key,
        current.get(engine.engine_key) ?? EMPTY_WINDOW_METRICS,
        prior.get(engine.engine_key) ?? EMPTY_WINDOW_METRICS,
      ),
    }));

    const blended = blendScorecards(
      entries.map((entry) => ({ scorecard: entry.scorecard, weight: entry.engine.weight })),
      engines.map((engine) => ({
        scorecard: toScorecard(engine.engine_key, prior.get(engine.engine_key) ?? EMPTY_WINDOW_METRICS, EMPTY_WINDOW_METRICS),
        weight: engine.weight,
      })),
    );

    return {
      project_id: projectId,
      timeframe: query.timeframe,
      window: { from: window.from, to: window.to, timezone: window.timezone },
      engines: entries.map((entry) => toEntry(entry.scorecard, entry.engine)),
      blended: toEntry(blended, null),
    };
  }

  /**
   * The window, in the PROJECT'S WORKSPACE TIMEZONE.
   *
   * Asked of Postgres rather than computed in Node, so the conversion uses
   * the same tz database `aggregateRange` does — a rollup bucketing a capture
   * into one day while this window excludes it would make the scorecard and
   * the chart disagree at every DST boundary.
   *
   * The prior window is the SAME LENGTH immediately before, which is what
   * §3's delta compares. An unaligned prior window would make the delta a
   * comparison of a month against a fortnight.
   */
  private async resolveWindow(tx: ClientBase, projectId: string, days: number): Promise<ResolvedWindow> {
    const settings = await tx.query<{ timezone: string }>(
      `SELECT w.timezone
         FROM projects p JOIN workspaces w ON w.id = p.workspace_id
        WHERE p.id = $1 AND p.deleted_at IS NULL`,
      [projectId],
    );
    const timezone = settings.rows[0]?.timezone;
    if (timezone === undefined) throw new NotFoundError({ message: "no such project" });

    const bounds = await tx.query<{ from: string; to: string; prior_from: string; prior_to: string }>(
      `SELECT to_char(today - make_interval(days => $1::int - 1), 'YYYY-MM-DD') AS from,
              to_char(today, 'YYYY-MM-DD')                                      AS to,
              to_char(today - make_interval(days => $1::int * 2 - 1), 'YYYY-MM-DD') AS prior_from,
              to_char(today - make_interval(days => $1::int), 'YYYY-MM-DD')     AS prior_to
         FROM (SELECT (now() AT TIME ZONE $2)::date AS today) t`,
      [days, timezone],
    );
    const row = bounds.rows[0]!;
    return { from: row.from, to: row.to, priorFrom: row.prior_from, priorTo: row.prior_to, timezone };
  }

  /**
   * The engines the screen has rows for, with the cadence the SCHEDULER
   * resolves.
   *
   * AC2 — `cadence_by_plan -> plan ->> 'full'`, the SAME EXPRESSION
   * `resolveDueEngines` evaluates, joined through the workspace's plan the
   * same way. Reading a different column, or rendering a stored label, is
   * how a screen ends up claiming daily while the scheduler runs weekly.
   *
   * `LEFT JOIN engines` rather than an inner one: a project may have a row
   * for an engine the catalog has since removed, and dropping it here would
   * silently shrink the screen rather than showing an engine with no
   * configuration behind it.
   */
  private async engineConfig(tx: ClientBase, projectId: string, requested: string[] | null): Promise<EngineConfig[]> {
    const result = await tx.query<{
      engine_key: string;
      display_name: string | null;
      runs_per_cycle: number | null;
      weight: string;
      last_captured_at: Date | null;
    }>(
      `SELECT pe.engine_key,
              e.display_name,
              (e.cadence_by_plan -> w.plan_key ->> 'full')::int AS runs_per_cycle,
              pe.weight::text AS weight,
              last_capture.captured_at AS last_captured_at
         FROM project_engines pe
         JOIN projects p   ON p.id = pe.project_id
         JOIN workspaces w ON w.id = p.workspace_id
         LEFT JOIN engines e ON e.key = pe.engine_key
         -- NOT WINDOWED, deliberately. An engine that last answered before
         -- the window is exactly the one worth surfacing, and clamping this
         -- to the window would report null for the engine that has been
         -- silent longest. Same rule as the matrix cell's last_success_at.
         LEFT JOIN LATERAL (
           SELECT max(c.captured_at) AS captured_at
             FROM answer_captures c
            WHERE c.project_id = pe.project_id
              AND c.engine_key = pe.engine_key
              AND c.status IN ('captured', 'parsed', 'skipped')
         ) last_capture ON true
        WHERE pe.project_id = $1 AND pe.enabled = true
          AND ($2::text[] IS NULL OR pe.engine_key = ANY($2::text[]))
        ORDER BY pe.engine_key ASC`,
      [projectId, requested],
    );

    if (result.rows.length === 0) await this.assertProjectExists(tx, projectId);

    return result.rows.map((row) => ({
      engine_key: row.engine_key,
      display_name: row.display_name,
      // 0 is the scheduler's fail-closed "this plan does not schedule this
      // engine", and it is not a cadence — it becomes null rather than a
      // "0 runs per cycle" the screen would have to special-case anyway.
      cadenceRunsPerCycle: row.runs_per_cycle !== null && row.runs_per_cycle > 0 ? row.runs_per_cycle : null,
      weight: Number(row.weight),
      lastCapturedAt: row.last_captured_at,
    }));
  }

  private async assertProjectExists(tx: ClientBase, projectId: string): Promise<void> {
    const rows = await tx.query("SELECT 1 FROM projects WHERE id = $1 AND deleted_at IS NULL", [projectId]);
    if (rows.rowCount === 0) throw new NotFoundError({ message: "no such project" });
  }

  /**
   * The BRAND's window metrics, per engine.
   *
   * `aggregateRange` returns brand and competitor rows; the brand's
   * `entity_id` is the project id, which is how the rollup writes it. The
   * competitor rows are what STORY-137's chart and EPIC-08's panel read —
   * this endpoint is the brand's scorecard and filters to it here rather
   * than in SQL, so the same query serves both.
   */
  private async brandMetricsByEngine(
    tx: ClientBase,
    projectId: string,
    from: string,
    to: string,
    timezone: string,
  ): Promise<Map<string, WindowMetrics>> {
    const aggregates = await aggregateRange(tx, projectId, from, to, timezone);
    const byEngine = new Map<string, WindowMetrics>();
    for (const aggregate of aggregates) {
      if (aggregate.entityType !== "brand") continue;
      byEngine.set(aggregate.engineKey, toWindowMetrics(aggregate));
    }
    return byEngine;
  }
}

/**
 * The next scheduled run for an engine.
 *
 * NULL WHEN THERE IS NOTHING TO PROJECT FROM. A plan that does not schedule
 * this engine has no interval; an engine that has never run has no last
 * capture to add one to. Inventing "now" for either would put a scan on the
 * header that nothing will start.
 */
function nextRunAt(engine: EngineConfig): string | null {
  if (engine.cadenceRunsPerCycle === null || engine.lastCapturedAt === null) return null;
  return new Date(engine.lastCapturedAt.getTime() + CYCLE_MS / engine.cadenceRunsPerCycle).toISOString();
}

/** `null` config marks the blended entry — it has no engine to name or schedule. */
function toEntry(scorecard: Scorecard, engine: EngineConfig | null): ScorecardEntry {
  return {
    engine_key: scorecard.engineKey,
    display_name: engine?.display_name ?? null,
    cadence_runs_per_cycle: engine?.cadenceRunsPerCycle ?? null,
    // The blended entry has no last scan and no next run: they are per-engine
    // facts, and a "blended last scan" would be the max of a set the reader
    // cannot see.
    last_captured_at: engine?.lastCapturedAt?.toISOString() ?? null,
    next_run_at: engine === null ? null : nextRunAt(engine),
    visibility_score: scorecard.visibilityScore,
    visibility_delta: scorecard.visibilityDelta,
    confidence: scorecard.confidence,
    confidence_half_width: scorecard.confidenceHalfWidth,
    measured_cells: scorecard.measuredCells,
    metrics: {
      presence_rate: scorecard.metrics.presenceRate,
      share_of_voice: scorecard.metrics.shareOfVoice,
      sentiment_score: scorecard.metrics.sentimentScore,
      citation_share: scorecard.metrics.citationShare,
      rendering_quality: scorecard.metrics.renderingQuality,
      cells_total: scorecard.metrics.cellsTotal,
      cells_present: scorecard.metrics.cellsPresent,
      mentions_total: scorecard.metrics.mentionsTotal,
      citations_total: scorecard.metrics.citationsTotal,
      citations_owned: scorecard.metrics.citationsOwned,
    },
    metrics_delta: {
      presence_rate: scorecard.metricsDelta.presenceRate,
      share_of_voice: scorecard.metricsDelta.shareOfVoice,
      sentiment_score: scorecard.metricsDelta.sentimentScore,
      citation_share: scorecard.metricsDelta.citationShare,
      rendering_quality: scorecard.metricsDelta.renderingQuality,
    },
  };
}

/** Echoed in `meta` so a client can tell which formula version produced the numbers. */
export const SCORECARDS_SCORING_VERSION = SCORING_VERSION;

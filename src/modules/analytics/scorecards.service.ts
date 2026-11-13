import { Injectable } from "@nestjs/common";
import type { ClientBase } from "pg";
import type { DataSource, ScorecardsQuery, ScorecardsResponse, ScorecardEntry } from "../../../contracts/analytics/index.js";
import { NotFoundError } from "../../api/errors/domain-errors.js";
import { parseEngineFilter } from "../../lib/analytics/engine-filter.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
import {
  blendScorecards,
  EMPTY_WINDOW_METRICS,
  toScorecard,
  toWindowMetrics,
  type Scorecard,
  type WindowMetrics,
} from "../../lib/analytics/scorecard.js";
import { blendDisclosure, combineDataSources, engineDataSourcesForDates, recordDemoDataServed } from "../../lib/analytics/data-source.js";
import { aggregateRange, answeredStatusSql, measurementStatusSql } from "../../lib/rollup/aggregate-day.js";
import { SCORING_VERSION } from "../../lib/scoring/index.js";
import type { PortalProjectEngines, PortalProjectFacts } from "../../lib/portal/portal-facts.js";
import { resolveWindow, TIMEFRAME_DAYS } from "../../lib/analytics/window.js";
import { customRangeDays } from "../../../contracts/analytics/custom-range.schema.js";

// STORY-136 — `GET /v1/projects/{id}/scorecards`.
//
// Every figure on the Project Overview screen, from one request. The
// arithmetic lives in `src/lib/analytics/scorecard.ts`; this resolves the
// window, reads the facts, and joins the engine configuration onto them.

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

@Injectable()
export class ScorecardsService {
  /**
   * `opts.days` overrides the query's window — the portal serves a 24h window the agency query has no spelling for.
   * `opts.portal` carries what `nominara_portal` cannot read (the workspace timezone and the project's engine rows,
   * read on the app pool by the portal interceptor); the facts and the arithmetic below are the same code.
   */
  async scorecards(projectId: string, query: ScorecardsQuery, opts: { readonly days?: number; readonly portal?: PortalProjectFacts } = {}): Promise<ScorecardsResponse> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("ScorecardsService requires an active tenant context");
    const tx = store.client;

    // STORY-090: `timeframe=custom` serves the days asked for or refuses with a reason (retention-bounded), never a trimmed range. The portal's own
    // `opts.days` window is a preset and takes precedence.
    const custom =
      opts.days === undefined && query.timeframe === "custom" && query.from !== undefined && query.to !== undefined
        ? { from: query.from, to: query.to, workspaceId: store.context.workspaceId, surface: "scorecards" }
        : undefined;
    const window = await resolveWindow(
      tx,
      projectId,
      opts.days ?? (query.timeframe === "custom" ? (custom === undefined ? TIMEFRAME_DAYS["30d"] : customRangeDays(custom.from, custom.to)) : TIMEFRAME_DAYS[query.timeframe]),
      opts.portal?.workspace.timezone,
      custom,
    );
    const requested = parseEngineFilter(query.engines);
    // ⚠ `priorFrom`, NOT `from` — THE MEMBERSHIP SPAN COVERS BOTH LEGS.
    //
    // `blendScorecards` builds the current AND prior blends from this one
    // list, so a list scoped to the current window gives the prior leg a
    // membership rule of "engines measured in the CURRENT window". An engine
    // measured in the prior window and silent since — the exact shape of a
    // downgrade — was then missing from `priorMetrics` while the stored
    // cross-engine rows counted it over those days, so `visibility_delta`,
    // the number the measured-membership rule exists to protect, was computed
    // over a set the rule does not describe.
    //
    // `priorTo` is `from - 1 day` (see resolveWindow), so `priorFrom … to` is
    // contiguous and one span covers both windows with no gap.
    //
    // Widening membership cannot move the CURRENT blend: an engine with no
    // current metrics carries `EMPTY_WINDOW_METRICS`, and `blendMetrics`
    // filters nulls before summing the denominator, so it is in neither
    // numerator nor denominator. It does make such an engine VISIBLE in the
    // response for up to one further window, which is correct — an engine
    // that stopped being measured is a thing the screen should show, not
    // hide.
    const engines = await this.engineConfig(tx, projectId, requested, window.priorFrom, window.to, window.timezone, opts.portal?.engines);

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

    // NEW-A-5 — provenance over the SAME span as the blend's membership
    // (prior window start to current end), so the marker describes every
    // capture that can move the score or its delta.
    const sources = await engineDataSourcesForDates(tx, projectId, window.priorFrom, window.to, window.timezone, SCORING_VERSION);
    const perEngine = entries.map((entry) => sources.get(entry.engine.engine_key) ?? null);
    recordDemoDataServed("scorecards", store.context.workspaceId, perEngine);

    return {
      project_id: projectId,
      timeframe: query.timeframe,
      window: { from: window.from, to: window.to, timezone: window.timezone },
      engines: entries.map((entry, index) => toEntry(entry.scorecard, entry.engine, perEngine[index]!)),
      blended: toEntry(blended, null, combineDataSources(perEngine)),
      blend: blendDisclosure(perEngine),
    };
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
  private async engineConfig(
    tx: ClientBase,
    projectId: string,
    requested: string[] | null,
    /** The lower bound of the MEMBERSHIP span — the PRIOR window's start. */
    measuredFrom: string,
    /** The current window's end. `measuredFrom … measuredTo` covers both legs. */
    measuredTo: string,
    timezone: string,
    /** NEW-E-099a — the portal's pre-read engine rows; absent on the agency path, which reads the view and the table. */
    portalEngines?: PortalProjectEngines,
  ): Promise<EngineConfig[]> {
    // The two relations the query reads that `nominara_portal` cannot: the entitled view and the override table. On the
    // portal path the same columns come from the rows the interceptor read on the app pool; nothing else changes.
    const entitledSource =
      portalEngines === undefined
        ? "project_entitled_engines"
        : `(SELECT $1::uuid AS project_id, x.engine_key, true AS enabled, x.display_name, x.weight::real AS weight,
                   CASE WHEN x.runs_per_cycle IS NULL THEN NULL ELSE jsonb_build_object('full', x.runs_per_cycle) END AS cadence
              FROM jsonb_to_recordset($7::jsonb) AS x(engine_key text, display_name text, runs_per_cycle int, weight text))`;
    const overrideSource =
      portalEngines === undefined
        ? "project_engines"
        : `(SELECT $1::uuid AS project_id, x.engine_key, x.weight::real AS weight FROM jsonb_to_recordset($8::jsonb) AS x(engine_key text, weight text))`;
    const portalParams = portalEngines === undefined ? [] : [JSON.stringify(portalEngines.entitled), JSON.stringify(portalEngines.overrides)];
    const result = await tx.query<{
      engine_key: string;
      display_name: string | null;
      runs_per_cycle: number | null;
      weight: string;
      last_captured_at: Date | null;
    }>(
      // THE VIEW, NOT project_engines — plus everything the window MEASURED.
      // STORY-152.
      //
      // Three joins collapse into the view, and it supplies the plan floor
      // this read never had, the display name, and the cadence. The cadence
      // matters most: this used to re-derive it with its own copy of
      // `cadence_by_plan -> plan_key ->> 'full'`, the same expression the
      // scheduler uses, written out a second time. FR-CRD-09 asks that the
      // customer-visible freshness figure cannot drift from the scheduler,
      // and two copies of an expression is exactly how it would. `pes.cadence`
      // IS the scheduler's object.
      //
      // ⚠ BUT ENTITLEMENT DOES NOT DECIDE MEMBERSHIP OF THE BLEND, AND THAT
      // DISTINCTION IS THE WHOLE `measured` CTE.
      //
      // Driving this query from the view alone — which is what the first
      // version of this change did — silently redefined the blended
      // visibility score as "over the engines you are entitled to TODAY".
      // The stored cross-engine row (`roll-up-day.ts`'s upsertCrossEngineRows,
      // which Growth Map and the trend series read) blends every engine with
      // a `metric_daily` row and applies no floor at all. Before this story
      // both were unfiltered and agreed; after it they disagreed by 17.75
      // points on a project holding an override for an engine its plan no
      // longer buys — reachable the moment a workspace downgrades, which
      // STORY-151 made possible.
      //
      // The rule, decided rather than inherited: A BLEND IS A STATEMENT ABOUT
      // WHAT WAS MEASURED. Entitlement governs what may be captured NEXT, so
      // it cannot retroactively remove a measurement that was taken — a past
      // day's score has to stay reproducible from an export, which is what
      // the 1e-9 reproducibility claim rests on.
      //
      // So the key set is ENTITLED ∪ MEASURED-IN-EITHER-WINDOW. The union is
      // deliberate in both directions:
      //   entitled-but-unmeasured — carries no metrics, so it changes no
      //   number (blendMetrics filters nulls before summing the denominator),
      //   and it renders as "enabled and never measured", which is the
      //   distinction the matrix draws too.
      //   measured-but-unentitled — carries the metrics that the stored
      //   rollup already counted, so the header now agrees with the chart.
      //
      // `measured` is scoped to the window because the blend is; an engine
      // last measured before it would add a row with nothing in it. The span
      // is the PRIOR window's start to the CURRENT window's end, because both
      // blend legs are built from this one list — see the call site.
      //
      // ⚠ AND IT USES `aggregateRange`'s OWN PREDICATE, CHARACTER FOR
      // CHARACTER — `(captured_at AT TIME ZONE tz)::date BETWEEN from AND to`
      // (aggregate-day.ts:139). The first version of this CTE wrote a
      // plausible equivalent instead, `captured_at >= from AND < to`, and it
      // was wrong in two independent ways:
      //
      //   `to` IS INCLUSIVE THERE AND WAS EXCLUSIVE HERE, so this discarded
      //   the window's entire final day. An engine whose only capture is
      //   TODAY carried metrics that `aggregateRange` returned and that this
      //   CTE could not see — dropping it from the blend while the stored
      //   rollup counted it. That is the exact divergence this CTE exists to
      //   close, reopened and narrowed to "the captures are from today",
      //   which is the day a customer opens their dashboard after a scan.
      //
      //   AND IT DID NOT CONVERT THE TIMEZONE. `aggregateRange` buckets in
      //   the WORKSPACE's zone; a bare 'YYYY-MM-DD' cast to timestamptz is
      //   parsed in the SESSION's. For Australia/Sydney that is a ten-hour
      //   skew, and combined with the above a Sydney workspace lost about the
      //   last 34 hours of its window.
      //
      // Two spellings of one boundary is the same defect this file already
      // avoids for the cadence expression. There is one spelling now, and it
      // is the aggregation's.
      `WITH measured AS (
         SELECT DISTINCT c.engine_key
           FROM answer_captures c
          WHERE c.project_id = $1
            -- ⚠ THE AGGREGATION'S OWN CONSTANT, NOT A COPY OF IT. This read
            -- IN ('captured','parsed','skipped') for a round: the same SET
            -- as the aggregation's rule and the opposite KIND of rule, an
            -- allow-list against a deny-list. Equal over today's five
            -- statuses, and divergent the moment a sixth is added -- the new
            -- value would count as a measurement in the stored rollup and
            -- not here, dropping the engine from the header's blend while
            -- the chart counted it. That is this story's round-2 divergence
            -- exactly, arriving by the last predicate that was still written
            -- out twice.
            --
            -- Interpolated from one definition so there is nothing to keep
            -- in step. The alias c is what the constant expects.
            AND ${measurementStatusSql()}
            AND (c.captured_at AT TIME ZONE $5)::date BETWEEN $3::date AND $4::date
            -- STORY-136 AC9 — the same version filter the aggregation applies, so membership describes the rows summed.
            AND c.scoring_version = $6
       ),
       engine_keys AS (
         SELECT e0.engine_key FROM ${entitledSource} e0 WHERE e0.project_id = $1 AND e0.enabled = true
         UNION
         SELECT engine_key FROM measured
       )
       SELECT k.engine_key,
              COALESCE(pes.display_name, cat.display_name) AS display_name,
              -- NULL for an unentitled engine, and correctly so: a plan that
              -- does not sell the engine schedules no runs of it. The screen
              -- already renders a null cadence.
              (pes.cadence ->> 'full')::int AS runs_per_cycle,
              -- Matches roll-up-day.ts's COALESCE(pe.weight, 1.0) exactly, so
              -- the two blends weight an engine identically. pes.weight
              -- already folds the override in for entitled engines.
              COALESCE(pes.weight, ov.weight, 1.0::real)::text AS weight,
              last_capture.captured_at AS last_captured_at
         FROM engine_keys k
         LEFT JOIN ${entitledSource} pes
                ON pes.project_id = $1 AND pes.engine_key = k.engine_key AND pes.enabled = true
         LEFT JOIN engines cat ON cat.key = k.engine_key
         LEFT JOIN ${overrideSource} ov ON ov.project_id = $1 AND ov.engine_key = k.engine_key
         -- NOT WINDOWED, deliberately. An engine that last answered before
         -- the window is exactly the one worth surfacing, and clamping this
         -- to the window would report null for the engine that has been
         -- silent longest. Same rule as the matrix cell's last_success_at.
         LEFT JOIN LATERAL (
           SELECT max(c.captured_at) AS captured_at
             FROM answer_captures c
            WHERE c.project_id = $1
              AND c.engine_key = k.engine_key
              AND ${answeredStatusSql()}
         ) last_capture ON true
        WHERE ($2::text[] IS NULL OR k.engine_key = ANY($2::text[]))
        ORDER BY k.engine_key ASC`,
      [projectId, requested, measuredFrom, measuredTo, timezone, SCORING_VERSION, ...portalParams],
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
    const aggregates = await aggregateRange(tx, projectId, from, to, timezone, SCORING_VERSION);
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
function toEntry(scorecard: Scorecard, engine: EngineConfig | null, dataSource: DataSource | null): ScorecardEntry {
  return {
    data_source: dataSource,
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

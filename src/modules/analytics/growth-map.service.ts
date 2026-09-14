import { Injectable } from "@nestjs/common";
import type { ClientBase } from "pg";
import type {
  GrowthMapQuery,
  GrowthMapResponse,
  GrowthMapSeries,
  MeasuredImpact,
  Milestone,
} from "../../../contracts/analytics/index.js";
import { NotFoundError } from "../../api/errors/domain-errors.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
import {
  baselinePoints,
  calendarDays,
  dataGaps,
  firstAndLastScored,
  pointsFor,
  type DailySeriesRow,
  type FailureDay,
} from "../../lib/analytics/growth-map.js";
import { CROSS_ENGINE_KEY } from "../../lib/rollup/roll-up-day.js";
import { SCORING_VERSION } from "../../lib/scoring/index.js";

// STORY-137 — `GET /v1/projects/{id}/growth-map`, §7's payload.

const TIMEFRAME_DAYS: Readonly<Record<GrowthMapQuery["timeframe"], number>> = Object.freeze({
  "7d": 7,
  "30d": 30,
  "90d": 90,
});

/**
 * `scoring-models.md` §14 — "every rendered impact figure carries the
 * mandatory caveat string", and `NFR-ANL-05` lint-enforces it on the copy
 * side.
 *
 * STAMPED HERE WHEN THE STORED IMPACT HAS NONE, rather than dropping the
 * impact or publishing it bare. The caveat is a fixed disclaimer about the
 * METHOD — pre/post observation cannot control for concurrent changes — not
 * a measurement, so supplying it invents nothing. A stored caveat wins,
 * because a future method may need to say something more specific.
 */
export const MILESTONE_IMPACT_CAVEAT = "Observational; concurrent changes are not controlled for.";

interface SeriesRow extends DailySeriesRow {
  entityType: "brand" | "competitor";
  label: string;
}

@Injectable()
export class GrowthMapService {
  async growthMap(projectId: string, query: GrowthMapQuery): Promise<GrowthMapResponse> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("GrowthMapService requires an active tenant context");
    const tx = store.client;

    const { from, to, timezone, brandLabel } = await this.resolveWindow(tx, projectId, TIMEFRAME_DAYS[query.timeframe]);
    const days = calendarDays(from, to);

    const wanted = new Set(
      (query.entities ?? "brand,competitors").split(",").map((entity) => entity.trim()).filter((entity) => entity.length > 0),
    );
    const wantBrand = wanted.has("brand");
    const wantCompetitors = wanted.has("competitors");

    const rows = await this.seriesRows(tx, projectId, from, to);
    const series: GrowthMapSeries[] = [];

    const brandRows = rows.filter((row) => row.entityType === "brand");
    const brandPoints = pointsFor(days, brandRows);
    if (wantBrand) {
      series.push({
        series_id: "brand",
        label: brandLabel,
        entity_type: "brand",
        color_role: "primary",
        points: brandPoints,
      });
    }

    const competitorSeries: GrowthMapSeries[] = [];
    if (wantCompetitors) {
      const byEntity = new Map<string, SeriesRow[]>();
      for (const row of rows) {
        if (row.entityType !== "competitor") continue;
        byEntity.set(row.entityId, [...(byEntity.get(row.entityId) ?? []), row]);
      }
      for (const [entityId, entityRows] of [...byEntity].sort(([left], [right]) => left.localeCompare(right))) {
        competitorSeries.push({
          series_id: `competitor:${entityId}`,
          label: entityRows[0]!.label,
          entity_type: "competitor",
          color_role: "comparison",
          points: pointsFor(days, entityRows),
        });
      }
      series.push(...competitorSeries);

      // Scenario 4 — NO BASELINE SERIES AT ALL when there are no competitors.
      // A "median" over an empty set is a line of nulls pretending to be a
      // cohort, and a chart legend naming a baseline nobody is in.
      if (competitorSeries.length > 0) {
        series.push({
          series_id: "competitor_baseline",
          label: "Competitor Baseline (median)",
          entity_type: "derived",
          color_role: "baseline",
          points: baselinePoints(days, competitorSeries),
        });
      }
    }

    const failures = await this.failureDays(tx, projectId, from, to, timezone);
    const baseline = series.find((entry) => entry.series_id === "competitor_baseline");
    const brandEnds = firstAndLastScored(brandPoints);
    const baselineEnds = baseline === undefined ? { start: null, end: null } : firstAndLastScored(baseline.points);

    return {
      granularity: "day",
      timeframe: { from, to, timezone },
      series,
      milestones: await this.milestones(tx, projectId, from, to, timezone),
      annotations: {
        // The gaps are the BRAND's. A competitor absent from an answer is not
        // a gap in the measurement — it is the measurement.
        data_gaps: dataGaps(brandPoints, failures),
        // Always empty: `project_engines` has no history table and nothing
        // records a cadence change, so there is no source to read. The field
        // stays so the annotation layer does not look complete.
        cadence_changes: [],
      },
      summary: {
        visibility_start: brandEnds.start,
        visibility_end: brandEnds.end,
        visibility_delta: brandEnds.start === null || brandEnds.end === null ? null : brandEnds.end - brandEnds.start,
        ...(await this.bestAndWorstEngine(tx, projectId, from, to)),
        competitor_gap_start: gapBetween(brandEnds.start, baselineEnds.start),
        competitor_gap_end: gapBetween(brandEnds.end, baselineEnds.end),
      },
      point_count: series.reduce((total, entry) => total + entry.points.length, 0),
    };
  }

  private async resolveWindow(
    tx: ClientBase,
    projectId: string,
    days: number,
  ): Promise<{ from: string; to: string; timezone: string; brandLabel: string }> {
    // The project's own timezone, for the reason the rollup gives: a project
    // in a distant zone has a different "today" than the server, and a
    // server-local window would put its captures on the wrong day.
    const settings = await tx.query<{ timezone: string; name: string }>(
      `SELECT w.timezone, p.name
         FROM projects p JOIN workspaces w ON w.id = p.workspace_id
        WHERE p.id = $1 AND p.deleted_at IS NULL`,
      [projectId],
    );
    const row = settings.rows[0];
    if (row === undefined) throw new NotFoundError({ message: "no such project" });

    const bounds = await tx.query<{ from: string; to: string }>(
      `SELECT to_char(today - make_interval(days => $1::int - 1), 'YYYY-MM-DD') AS from,
              to_char(today, 'YYYY-MM-DD')                                      AS to
         FROM (SELECT (now() AT TIME ZONE $2)::date AS today) t`,
      [days, row.timezone],
    );
    return { from: bounds.rows[0]!.from, to: bounds.rows[0]!.to, timezone: row.timezone, brandLabel: row.name };
  }

  /**
   * The `engine_key='all'` rows — the blend the rollup's second pass writes.
   *
   * A chart of "visibility over time" plots the blended figure; the
   * per-engine breakdown is the scorecard's job. Reading the per-engine rows
   * and re-blending them here would recompute, per day, what the rollup
   * already computed and stored.
   */
  private async seriesRows(tx: ClientBase, projectId: string, from: string, to: string): Promise<SeriesRow[]> {
    const result = await tx.query<{
      entity_type: "brand" | "competitor";
      entity_id: string;
      label: string | null;
      metric_date: string;
      visibility_score: string;
      sov: string;
      cells_total: string;
      live_capture_ratio: string;
    }>(
      `SELECT md.entity_type,
              md.entity_id::text,
              COALESCE(c.name, p.name) AS label,
              to_char(md.metric_date, 'YYYY-MM-DD') AS metric_date,
              md.visibility_score::text,
              md.sov::text,
              md.cells_total::text,
              md.live_capture_ratio::text
         FROM metric_daily md
         JOIN projects p        ON p.id = md.project_id
         LEFT JOIN competitors c ON c.id = md.entity_id AND md.entity_type = 'competitor'
        WHERE md.project_id = $1
          AND md.engine_key = $2
          AND md.scoring_version = $3
          AND md.metric_date BETWEEN $4::date AND $5::date
        ORDER BY md.metric_date ASC`,
      [projectId, CROSS_ENGINE_KEY, SCORING_VERSION, from, to],
    );

    return result.rows.map((row) => ({
      entityType: row.entity_type,
      entityId: row.entity_id,
      label: row.label ?? row.entity_id,
      metricDate: row.metric_date,
      visibilityScore: Number(row.visibility_score),
      sov: Number(row.sov),
      cellsTotal: Number(row.cells_total),
      liveCaptureRatio: Number(row.live_capture_ratio),
    }));
  }

  /** Which engines returned a failure on which workspace-local day — the reason behind a gap. */
  private async failureDays(
    tx: ClientBase,
    projectId: string,
    from: string,
    to: string,
    timezone: string,
  ): Promise<FailureDay[]> {
    const result = await tx.query<{ metric_date: string; engine_key: string }>(
      `SELECT DISTINCT to_char((captured_at AT TIME ZONE $4)::date, 'YYYY-MM-DD') AS metric_date, engine_key
         FROM answer_captures
        WHERE project_id = $1
          AND (captured_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
          AND status IN ('failed', 'blocked')`,
      [projectId, from, to, timezone],
    );
    return result.rows.map((row) => ({ metricDate: row.metric_date, engineKey: row.engine_key }));
  }

  /**
   * §7's `best_engine` and `worst_engine`, over the window's per-engine rows.
   *
   * Weighted by cells rather than a mean of daily scores, for the same reason
   * STORY-136 gives: a day with four cells should not weigh as much as a day
   * with four hundred.
   */
  private async bestAndWorstEngine(
    tx: ClientBase,
    projectId: string,
    from: string,
    to: string,
  ): Promise<{ best_engine: string | null; worst_engine: string | null }> {
    const result = await tx.query<{ engine_key: string }>(
      `SELECT engine_key
         FROM metric_daily
        WHERE project_id = $1
          AND engine_key <> $2
          AND entity_type = 'brand'
          AND scoring_version = $3
          AND metric_date BETWEEN $4::date AND $5::date
        GROUP BY engine_key
       HAVING sum(cells_total) > 0
        ORDER BY sum(visibility_score * cells_total) / sum(cells_total) DESC, engine_key ASC`,
      [projectId, CROSS_ENGINE_KEY, SCORING_VERSION, from, to],
    );
    const engines = result.rows.map((row) => row.engine_key);
    // ONE ENGINE IS NEITHER BEST NOR WORST. Naming it both would put the same
    // engine on both ends of a comparison that has no other side.
    if (engines.length < 2) return { best_engine: null, worst_engine: null };
    return { best_engine: engines[0]!, worst_engine: engines[engines.length - 1]! };
  }

  private async milestones(
    tx: ClientBase,
    projectId: string,
    from: string,
    to: string,
    timezone: string,
  ): Promise<Milestone[]> {
    const result = await tx.query<{
      id: string;
      occurred_at: Date;
      kind: string;
      title: string;
      detail: string | null;
      severity: "info" | "positive" | "warning";
      source_type: string | null;
      source_id: string | null;
      affected_engines: string[];
      measured_impact: Record<string, unknown> | null;
      visible_in_portal: boolean;
    }>(
      `SELECT id::text, occurred_at, kind, title, detail, severity, source_type, source_id::text,
              affected_engines, measured_impact, visible_in_portal
         FROM milestones
        WHERE project_id = $1
          AND (occurred_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
        ORDER BY occurred_at ASC`,
      [projectId, from, to, timezone],
    );

    return result.rows.map((row) => ({
      milestone_id: row.id,
      occurred_at: row.occurred_at.toISOString(),
      kind: row.kind,
      title: row.title,
      detail: row.detail,
      severity: row.severity,
      source: row.source_type === null ? null : { type: row.source_type, id: row.source_id },
      affected_engines: row.affected_engines,
      measured_impact: toMeasuredImpact(row.measured_impact),
      visible_in_portal: row.visible_in_portal,
    }));
  }
}

/** The gap between the brand and the baseline — null unless BOTH ends exist. */
function gapBetween(brand: number | null, baseline: number | null): number | null {
  return brand === null || baseline === null ? null : brand - baseline;
}

/**
 * `measured_impact` is free jsonb, so it is validated rather than trusted.
 *
 * A row missing any of §7's fields yields NULL — the milestone still renders,
 * without an impact figure. Publishing a partial impact would put a delta on
 * screen with no window, no method and no confidence beside it, which is the
 * shape of the causal claim `NFR-ANL-05` exists to prevent.
 */
function toMeasuredImpact(stored: Record<string, unknown> | null): MeasuredImpact | null {
  if (stored === null) return null;
  const num = (key: string): number | null => (typeof stored[key] === "number" ? (stored[key] as number) : null);
  const before = num("visibility_before");
  const after = num("visibility_after_14d");
  const delta = num("delta");
  const windowDays = num("window_days");
  const confidence = stored["confidence"];
  const method = stored["method"];

  if (before === null || after === null || delta === null || windowDays === null || windowDays <= 0) return null;
  if (confidence !== "low" && confidence !== "medium" && confidence !== "high") return null;
  if (typeof method !== "string" || method.length === 0) return null;

  const caveat = typeof stored["caveat"] === "string" && stored["caveat"].length > 0 ? stored["caveat"] : MILESTONE_IMPACT_CAVEAT;

  return {
    visibility_before: before,
    visibility_after_14d: after,
    delta,
    window_days: windowDays,
    confidence,
    method,
    caveat,
  };
}

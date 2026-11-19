import { Injectable } from "@nestjs/common";
import { aggregateRange, aggregateRangeByDay, nonMeasurementStatusSql, type DayVersionAggregate } from "../../lib/rollup/aggregate-day.js";
import type { ClientBase } from "pg";
import {
  GROWTH_MAP_GRANULARITY,
  type DataGap,
  type DataSource,
  type GrowthMapGranularity,
  type GrowthMapPoint,
  type GrowthMapQuery,
  type GrowthMapResponse,
  type GrowthMapSeries,
  type GrowthMapTimeframe,
  type MeasuredImpact,
  type Milestone,
} from "../../../contracts/analytics/index.js";
import { NotFoundError } from "../../api/errors/domain-errors.js";
import { customRangeDays, customRangeGranularity } from "../../../contracts/analytics/custom-range.schema.js";
import { resolveTopicFilter } from "../../lib/analytics/topic-filter.js";
import { assertCustomRangeAllowed } from "../../lib/analytics/custom-range.js";
import { MEASURED_IMPACT_CAVEAT } from "../../../contracts/tasks/task-verification.schema.js";
import { currentTenantStore, type TenantContextStore } from "../../tenancy/tenant-context.js";
import {
  baselinePoints,
  bucketFailures,
  calendarDays,
  dataGaps,
  extendGapsToBucketEnds,
  firstAndLastScored,
  hourBuckets,
  hourLabel,
  parseCadenceChange,
  pickScoringVersion,
  pointsFor,
  resampleWeekly,
  summaryDelta,
  type VersionOf,
  weekVersions,
  versionChanges,
  weekBuckets,
  weekLabelFor,
  type FailureDay,
  type VersionedSeriesRow,
  type WeekBucket,
} from "../../lib/analytics/growth-map.js";
import { narrowToEntitled, parseEngineFilter } from "../../lib/analytics/engine-filter.js";
import {
  combineDataSources,
  engineDataSourcesForDates,
  engineDataSourcesForInstants,
  recordDemoDataServed,
} from "../../lib/analytics/data-source.js";
import { blendEngineParts, CROSS_ENGINE_KEY, toMetricRow, type EnginePart } from "../../lib/rollup/roll-up-day.js";
import { SCORING_VERSION } from "../../lib/scoring/index.js";

// STORY-137 — `GET /v1/projects/{id}/growth-map`, §7's payload.
// STORY-066 — §13's three window shapes: `24h → hour` (read from the captures,
// pruned to one day), `7d/30d/90d → day` and `>90d → week` (from the rollup).

/** The trailing whole days each day- or week-granularity timeframe covers. `24h` is read by the hour and never uses it. */
const TIMEFRAME_DAYS: Readonly<Record<Exclude<GrowthMapTimeframe, "custom">, number>> = Object.freeze({
  "24h": 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "180d": 180,
  "365d": 365,
});

const HOUR_MS = 3_600_000;

/**
 * `scoring-models.md` §14 — "every rendered impact figure carries the
 * mandatory caveat string", and `NFR-ANL-05` lint-enforces it on the copy
 * side.
 *
 * STAMPED HERE WHEN THE STORED IMPACT HAS NONE, rather than dropping the
 * impact or publishing it bare. The caveat is a fixed disclaimer about the
 * METHOD — pre/post observation cannot control for concurrent changes — not
 * a measurement, so supplying it invents nothing. A stored caveat wins,
 * because a future method may need to say something more specific. The
 * default is the contract's ONE constant (STORY-067's settler writes the same
 * string), so the writer and this reader cannot drift.
 */
export const MILESTONE_IMPACT_CAVEAT = MEASURED_IMPACT_CAVEAT;

export interface GrowthMapOptions {
  readonly days?: number;
  readonly portal?: { readonly hideCompetitors: boolean; /** The workspace timezone, which `nominara_portal` cannot read. */ readonly timezone: string };
}

interface SeriesRow extends VersionedSeriesRow {
  entityType: "brand" | "competitor";
  label: string;
}

/** The milestone window: workspace-local dates (day/week) or a [from, to) instant range (hour). */
type MilestoneWindow =
  | { readonly kind: "dates"; readonly from: string; readonly to: string; readonly timezone: string }
  | { readonly kind: "instants"; readonly from: string; readonly to: string };

/** A cadence-change pin, with the local day and the UTC hour it fell in. */
interface CadencePin {
  readonly day: string;
  readonly at: number;
  readonly from: string;
  readonly to: string;
}

@Injectable()
export class GrowthMapService {
  /**
   * `opts.days` overrides the query's window (the portal serves a 24h window the agency query has no spelling for)
   * and is always read by the day. `opts.portal` is the portal's read: milestones with `visible_in_portal=false` are
   * excluded in the SQL, and under `hideCompetitors` so are the milestones that name a competitor.
   */
  async growthMap(projectId: string, query: GrowthMapQuery, opts: GrowthMapOptions = {}): Promise<GrowthMapResponse> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("GrowthMapService requires an active tenant context");
    const tx = store.client;

    // STORY-090: `timeframe=custom` plots the days asked for or refuses with a reason (retention-bounded), never a trimmed range. The portal's own
    // `opts.days` window is a preset and takes precedence.
    const custom =
      opts.days === undefined && query.timeframe === "custom" && query.from !== undefined && query.to !== undefined ? { from: query.from, to: query.to } : undefined;

    // §13 — auto-selected (a custom range by its own length). The contract already refused a mismatched `granularity`, so it is never consulted here.
    const granularity: GrowthMapGranularity =
      opts.days !== undefined ? "day" : custom !== undefined ? customRangeGranularity(customRangeDays(custom.from, custom.to)) : GROWTH_MAP_GRANULARITY[query.timeframe as Exclude<GrowthMapTimeframe, "custom">];

    const wanted = new Set(
      (query.entities ?? "brand,competitors").split(",").map((entity) => entity.trim()).filter((entity) => entity.length > 0),
    );
    // NEW-A-14 — `engines` narrows the entitled set; null means no narrowing.
    const requested = parseEngineFilter(query.engines);
    const selected = requested === null ? null : narrowToEntitled(requested, await this.entitledEngines(tx, projectId));

    if (granularity === "hour") return this.hourly(tx, store, projectId, wanted, selected, query.topics, opts.portal);
    return this.fromRollup(
      tx,
      store,
      projectId,
      wanted,
      selected,
      granularity,
      query.topics,
      opts.days ?? (custom !== undefined ? customRangeDays(custom.from, custom.to) : TIMEFRAME_DAYS[query.timeframe as Exclude<GrowthMapTimeframe, "custom">]),
      opts.portal,
      custom,
    );
  }

  /** Day and week granularity: the rollup layer (`metric_daily`), never the captures. */
  private async fromRollup(
    tx: ClientBase,
    store: TenantContextStore,
    projectId: string,
    wanted: ReadonlySet<string>,
    selected: readonly string[] | null,
    granularity: "day" | "week",
    rawTopics: string | undefined,
    windowDays: number,
    portal: GrowthMapOptions["portal"],
    custom?: { readonly from: string; readonly to: string },
  ): Promise<GrowthMapResponse> {
    const { from, to, timezone, brandLabel } = await this.resolveWindow(tx, projectId, windowDays, portal?.timezone, custom === undefined ? undefined : { ...custom, workspaceId: store.context.workspaceId });
    // STORY-090 AC8 - after the window, so a missing project is still the 404.
    const topics = await resolveTopicFilter(tx, projectId, rawTopics);
    const days = calendarDays(from, to);
    const buckets: readonly WeekBucket[] | null = granularity === "week" ? weekBuckets(days) : null;
    const labels = buckets === null ? days : buckets.map((bucket) => bucket.label);
    /**
     * Daily points → the points plotted: unchanged by the day, the mean of the dailies by the week (§13) — and, AC12, a week's
     * mean only of the days under its own scoring version (`versionOf`, the series' version per day), never of two versions.
     */
    const plot = (points: GrowthMapPoint[], versionOf: VersionOf): GrowthMapPoint[] =>
      buckets === null ? points : resampleWeekly(buckets, points, versionOf);
    const labelOfDay = (day: string): string => (buckets === null ? day : weekLabelFor(buckets, day));

    // A topic filter has no stored rollup (`metric_daily` is not cut by cluster), so the series are scored live from the member prompts' cells by the
    // rollup's own aggregation and blend - the same formula the stored rows come from, over fewer cells.
    const topicScored = topics === null ? null : await this.topicSeries(tx, projectId, days, timezone, selected, topics, brandLabel);
    const rows = topicScored === null ? await this.seriesRows(tx, projectId, from, to, selected) : topicScored.rows;
    // NEW-A-5 — the series are the cross-engine blend, so each one carries the
    // combination of every measured engine's provenance in the window.
    // AC12 — every scoring version's captures: the series plots older-version days, so their provenance is counted too.
    const allSources = await engineDataSourcesForDates(tx, projectId, from, to, timezone, null);
    const engineSources = new Map([...allSources].filter(([engine]) => selected === null || selected.includes(engine)));
    recordDemoDataServed("growth_map", store.context.workspaceId, [...engineSources.values()]);
    const blendSource: DataSource | null = combineDataSources([...engineSources.values()]);

    const brandRows = rows.filter((row) => row.entityType === "brand");
    const competitorDaily = new Map<string, { label: string; points: GrowthMapPoint[]; versions: Map<string, string> }>();
    for (const row of rows) {
      if (row.entityType !== "competitor") continue;
      const entry = competitorDaily.get(row.entityId) ?? { label: row.label, points: [], versions: new Map<string, string>() };
      entry.versions.set(row.metricDate, row.scoringVersion);
      competitorDaily.set(row.entityId, entry);
    }
    for (const [entityId, entry] of competitorDaily) {
      entry.points = pointsFor(days, rows.filter((row) => row.entityType === "competitor" && row.entityId === entityId));
    }
    // The baseline is the median PER DAY (§13), and only then averaged into a week like any other daily value.
    const dailyBaseline = baselinePoints(
      days,
      [...competitorDaily.values()].map((entry) => ({ series_id: "", label: "", entity_type: "competitor", color_role: "comparison", points: entry.points, data_source: null })),
    );

    const failures = (await this.failureDays(tx, projectId, from, to, timezone)).filter(
      (failure) => selected === null || selected.includes(failure.engineKey),
    );
    // AC12 — the brand's version per day. The baseline is bucketed by it too, so the brand and the baseline it is compared
    // against are always the same days of a week.
    const versionByDay = new Map(brandRows.map((row) => [row.metricDate, row.scoringVersion]));
    const brandVersionOf: VersionOf = (day) => versionByDay.get(day) ?? null;
    const dailyBrandPoints = pointsFor(days, brandRows);
    const brandPoints = plot(dailyBrandPoints, brandVersionOf);
    const brandVersions = buckets === null ? days.map(brandVersionOf) : weekVersions(buckets, dailyBrandPoints, brandVersionOf);
    // The gaps are the BRAND's. A competitor absent from an answer is not a gap in the measurement — it is the measurement.
    const dataGapsPlotted: DataGap[] =
      buckets === null ? dataGaps(brandPoints, failures) : extendGapsToBucketEnds(dataGaps(brandPoints, bucketFailures(failures, buckets)), buckets);

    // AC12 — each change of the brand's version announced at the bucket holding its first day under the new version.
    const scoringVersionChanges = versionChanges(days, days.map((day) => versionByDay.get(day) ?? null)).map((change) => ({
      ...change,
      at: labelOfDay(change.at),
    }));

    const { milestones, cadence } = await this.milestones(tx, projectId, { kind: "dates", from, to, timezone }, portal);

    return this.assemble({
      granularity,
      timeframe: { from: labels[0] ?? from, to, timezone },
      labels,
      wanted,
      brandLabel,
      brandPoints,
      brandVersions,
      competitors: [...competitorDaily].map(([entityId, entry]) => ({
        entityId,
        label: entry.label,
        points: plot(entry.points, (day) => entry.versions.get(day) ?? null),
      })),
      baseline: plot(dailyBaseline, brandVersionOf),
      blendSource,
      engineSources,
      milestones,
      dataGaps: dataGapsPlotted,
      cadenceChanges: cadence.map((pin) => ({ at: labelOfDay(pin.day), from: pin.from, to: pin.to })),
      scoringVersionChanges,
      bestAndWorst: topicScored === null ? await this.bestAndWorstEngine(tx, projectId, from, to, selected) : topicScored.bestAndWorst,
    });
  }

  /**
   * STORY-090 AC8 - the day-granularity series for a topic selection: per workspace-local day, the aggregation over the selected clusters' member prompts,
   * each entity blended across engines by `blendEngineParts` with the engines' weights - what `roll-up-day` writes, over a narrower set of cells. A day
   * with no cell for these topics has no row, which the plot draws as a gap (null), never a zero.
   *
   * ONE grouped query for the whole window (`aggregateRangeByDay`: the rollup's own aggregation SQL with a day-and-version group key), so the number of
   * queries does not depend on the window's length (it was one per day, up to 366). The rollup cannot answer this: it is not cut by cluster. The
   * scores are still `toMetricRow` and `blendEngineParts` over those counts; there is no second formula.
   *
   * SCORING VERSIONS: the same as the unfiltered series (AC12). Cells are grouped under their own capture's version and each (entity, day) takes the
   * current version where it has cells, else the version of its most recent cell, so a day measured under an older version is plotted with its
   * version and the change is announced, not drawn as a gap.
   */
  private async topicSeries(
    tx: ClientBase,
    projectId: string,
    days: readonly string[],
    timezone: string,
    selected: readonly string[] | null,
    topics: readonly string[],
    brandLabel: string,
  ): Promise<{ rows: SeriesRow[]; bestAndWorst: { best_engine: string | null; worst_engine: string | null } }> {
    const weights = new Map(
      (await tx.query<{ engine_key: string; weight: string | null }>("SELECT engine_key, weight::text FROM project_engines WHERE project_id = $1", [projectId])).rows.map(
        (row) => [row.engine_key, row.weight === null ? 1 : Number(row.weight)],
      ),
    );
    const competitorNames = new Map(
      (await tx.query<{ id: string; name: string }>("SELECT id::text, name FROM competitors WHERE project_id = $1", [projectId])).rows.map((row) => [row.id, row.name]),
    );
    // ONE grouped query for the whole window (day x scoring version), not one per day: the request's cost no longer grows with the window.
    const aggregates =
      days.length === 0
        ? []
        : (await aggregateRangeByDay(tx, projectId, days[0]!, days[days.length - 1]!, timezone, topics)).filter(
            (aggregate) => selected === null || selected.includes(aggregate.engineKey),
          );
    // AC12, as the unfiltered series: ONE scoring version per (entity, day) - the current version where the day has it, otherwise the one whose newest cell is
    // the most recent (the live analogue of "most recently computed") - chosen BEFORE blending, so two versions are never averaged together.
    const chosen = new Map<string, DayVersionAggregate[]>();
    const versionOf = new Map<string, DayVersionAggregate>();
    for (const aggregate of aggregates) {
      const key = `${aggregate.entityType}|${aggregate.entityId}|${aggregate.metricDate}`;
      const held = versionOf.get(key);
      const aggregateCurrent = aggregate.scoringVersion === SCORING_VERSION;
      const heldCurrent = held?.scoringVersion === SCORING_VERSION;
      if (held === undefined || (aggregateCurrent && !heldCurrent) || (aggregateCurrent === heldCurrent && aggregate.newestCaptureMs > held.newestCaptureMs)) {
        versionOf.set(key, aggregate);
      }
    }
    for (const aggregate of aggregates) {
      const key = `${aggregate.entityType}|${aggregate.entityId}|${aggregate.metricDate}`;
      if (versionOf.get(key)!.scoringVersion !== aggregate.scoringVersion) continue;
      chosen.set(key, [...(chosen.get(key) ?? []), aggregate]);
    }
    const rows: SeriesRow[] = [];
    const engineTotals = new Map<string, { weighted: number; cells: number }>();
    // Day order, then entity: the order the per-day loop produced.
    const dayThenEntity = (key: string): string => {
      const [entityType, entityId, day] = key.split("|");
      return `${day!}|${entityType!}|${entityId!}`;
    };
    for (const key of [...chosen.keys()].sort((left, right) => (dayThenEntity(left) < dayThenEntity(right) ? -1 : 1))) {
      const [entityType, entityId, day] = key.split("|") as ["brand" | "competitor", string, string];
      const entityParts: EnginePart[] = [];
      for (const aggregate of chosen.get(key)!) {
        const metric = toMetricRow(aggregate);
        const weight = weights.get(aggregate.engineKey) ?? 1;
        entityParts.push({ weight, cellsTotal: metric.cellsTotal, sovWeighted: metric.sov * weight, visibilityScore: metric.visibilityScore, liveCells: aggregate.liveCells });
        if (entityType === "brand") {
          const total = engineTotals.get(aggregate.engineKey) ?? { weighted: 0, cells: 0 };
          engineTotals.set(aggregate.engineKey, { weighted: total.weighted + metric.visibilityScore * metric.cellsTotal, cells: total.cells + metric.cellsTotal });
        }
      }
      const blended = blendEngineParts(entityParts);
      const stamp = versionOf.get(key)!;
      rows.push({
        entityType,
        entityId,
        label: entityType === "brand" ? brandLabel : (competitorNames.get(entityId) ?? entityId),
        metricDate: day,
        visibilityScore: blended.visibilityScore,
        sov: blended.sov,
        cellsTotal: blended.cellsTotal,
        liveCaptureRatio: blended.liveCaptureRatio,
        scoringVersion: stamp.scoringVersion,
        computedAt: stamp.newestCaptureMs,
      });
    }
    // The same rule as `bestAndWorstEngine`: cells-weighted, and ONE ENGINE IS NEITHER BEST NOR WORST.
    const ranked = [...engineTotals]
      .filter(([, total]) => total.cells > 0)
      .sort(([leftEngine, left], [rightEngine, right]) => right.weighted / right.cells - left.weighted / left.cells || leftEngine.localeCompare(rightEngine))
      .map(([engine]) => engine);
    return { rows, bestAndWorst: ranked.length < 2 ? { best_engine: null, worst_engine: null } : { best_engine: ranked[0]!, worst_engine: ranked[ranked.length - 1]! } };
  }

  /**
   * §13 / AC1 — the 24h view, the ONLY one that reads `answer_captures`.
   *
   * Every read is bounded by [first hour, last hour + 1h) on the raw partition
   * key, so Postgres prunes to the one or two monthly partitions a day can
   * span; the date predicates the rollup uses are expressions over
   * `captured_at` and cannot prune. Each hour is aggregated by the rollup's
   * own `aggregateRange` and scored by the scoring library through
   * `toMetricRow` and `blendEngineParts` — the stored daily rows' exact
   * path — so an hour and a day are never two formulas.
   *
   * Only the CURRENT scoring version's captures are read, so the window has
   * no version boundary to mark.
   */
  private async hourly(
    tx: ClientBase,
    store: TenantContextStore,
    projectId: string,
    wanted: ReadonlySet<string>,
    selected: readonly string[] | null,
    rawTopics: string | undefined,
    portal: GrowthMapOptions["portal"],
  ): Promise<GrowthMapResponse> {
    const { timezone, brandLabel } = await this.projectSettings(tx, projectId, portal?.timezone);
    // STORY-090 AC8 - null is the whole project; ids the project lacks are a 400 naming `topics`.
    const topics = await resolveTopicFilter(tx, projectId, rawTopics);
    const hours = hourBuckets(Date.now());
    const fromInstant = hours[0]!;
    const toInstant = hourLabel(Date.parse(hours[hours.length - 1]!) + HOUR_MS);

    const weights = new Map(
      (
        await tx.query<{ engine_key: string; weight: string | null }>(
          "SELECT engine_key, weight::text FROM project_engines WHERE project_id = $1",
          [projectId],
        )
      ).rows.map((row) => [row.engine_key, row.weight === null ? 1 : Number(row.weight)]),
    );
    const competitorNames = new Map(
      (await tx.query<{ id: string; name: string }>("SELECT id::text, name FROM competitors WHERE project_id = $1", [projectId])).rows.map(
        (row) => [row.id, row.name],
      ),
    );

    /** entity key → hour → the blended point. */
    const byEntity = new Map<string, Map<string, GrowthMapPoint>>();
    const engineTotals = new Map<string, { weighted: number; cells: number }>();
    for (const hour of hours) {
      const hourEnd = hourLabel(Date.parse(hour) + HOUR_MS);
      const day = hour.slice(0, 10);
      const aggregates = (await aggregateRange(tx, projectId, day, day, "UTC", SCORING_VERSION, { from: hour, to: hourEnd }, topics ?? undefined)).filter(
        (aggregate) => selected === null || selected.includes(aggregate.engineKey),
      );
      const parts = new Map<string, EnginePart[]>();
      for (const aggregate of aggregates) {
        const row = toMetricRow(aggregate);
        const weight = weights.get(aggregate.engineKey) ?? 1;
        const key = `${aggregate.entityType}|${aggregate.entityId}`;
        parts.set(key, [
          ...(parts.get(key) ?? []),
          { weight, cellsTotal: row.cellsTotal, sovWeighted: row.sov * weight, visibilityScore: row.visibilityScore, liveCells: aggregate.liveCells },
        ]);
        if (aggregate.entityType === "brand") {
          const total = engineTotals.get(aggregate.engineKey) ?? { weighted: 0, cells: 0 };
          engineTotals.set(aggregate.engineKey, { weighted: total.weighted + row.visibilityScore * row.cellsTotal, cells: total.cells + row.cellsTotal });
        }
      }
      for (const [key, entityParts] of parts) {
        const blended = blendEngineParts(entityParts);
        const points = byEntity.get(key) ?? new Map<string, GrowthMapPoint>();
        points.set(hour, { d: hour, visibility_score: blended.visibilityScore, sov: blended.sov, cells: blended.cellsTotal, live_ratio: blended.liveCaptureRatio });
        byEntity.set(key, points);
      }
    }
    const pointsOf = (key: string): GrowthMapPoint[] =>
      hours.map((hour) => byEntity.get(key)?.get(hour) ?? { d: hour, visibility_score: null, sov: null, cells: 0, live_ratio: null });

    const competitors = [...byEntity.keys()]
      .filter((key) => key.startsWith("competitor|"))
      .map((key) => key.slice("competitor|".length))
      .sort((left, right) => left.localeCompare(right))
      .map((entityId) => ({ entityId, label: competitorNames.get(entityId) ?? entityId, points: pointsOf(`competitor|${entityId}`) }));
    const brandPoints = pointsOf(`brand|${projectId}`);

    const allSources = await engineDataSourcesForInstants(tx, projectId, fromInstant, toInstant, SCORING_VERSION);
    const engineSources = new Map([...allSources].filter(([engine]) => selected === null || selected.includes(engine)));
    recordDemoDataServed("growth_map", store.context.workspaceId, [...engineSources.values()]);

    const failures = (await this.failureHours(tx, projectId, fromInstant, toInstant)).filter(
      (failure) => selected === null || selected.includes(failure.engineKey),
    );
    const { milestones, cadence } = await this.milestones(tx, projectId, { kind: "instants", from: fromInstant, to: toInstant }, portal);

    const ranked = [...engineTotals]
      .filter(([, total]) => total.cells > 0)
      .sort(([leftEngine, left], [rightEngine, right]) => right.weighted / right.cells - left.weighted / left.cells || leftEngine.localeCompare(rightEngine))
      .map(([engine]) => engine);

    return this.assemble({
      granularity: "hour",
      timeframe: { from: fromInstant, to: hours[hours.length - 1]!, timezone },
      labels: hours,
      wanted,
      brandLabel,
      brandPoints,
      competitors,
      baseline: baselinePoints(
        hours,
        competitors.map((entry) => ({ series_id: "", label: "", entity_type: "competitor", color_role: "comparison", points: entry.points, data_source: null })),
      ),
      blendSource: combineDataSources([...engineSources.values()]),
      engineSources,
      milestones,
      dataGaps: dataGaps(brandPoints, failures),
      cadenceChanges: cadence.map((pin) => ({ at: hourLabel(pin.at), from: pin.from, to: pin.to })),
      scoringVersionChanges: [],
      // ONE ENGINE IS NEITHER BEST NOR WORST — the same rule as `bestAndWorstEngine`.
      bestAndWorst: ranked.length < 2 ? { best_engine: null, worst_engine: null } : { best_engine: ranked[0]!, worst_engine: ranked[ranked.length - 1]! },
    });
  }

  /** §7's payload from the plotted points — one shape for all three granularities. */
  private assemble(parts: {
    granularity: GrowthMapGranularity;
    timeframe: GrowthMapResponse["timeframe"];
    labels: readonly string[];
    wanted: ReadonlySet<string>;
    brandLabel: string;
    brandPoints: GrowthMapPoint[];
    /** Each brand point's scoring version (AC12); absent where the window has only the current one (24h). */
    brandVersions?: readonly (string | null)[];
    competitors: readonly { entityId: string; label: string; points: GrowthMapPoint[] }[];
    baseline: GrowthMapPoint[];
    blendSource: DataSource | null;
    engineSources: ReadonlyMap<string, DataSource>;
    milestones: Milestone[];
    dataGaps: DataGap[];
    cadenceChanges: GrowthMapResponse["annotations"]["cadence_changes"];
    scoringVersionChanges: GrowthMapResponse["annotations"]["scoring_version_changes"];
    bestAndWorst: { best_engine: string | null; worst_engine: string | null };
  }): GrowthMapResponse {
    const series: GrowthMapSeries[] = [];
    if (parts.wanted.has("brand")) {
      series.push({
        series_id: "brand",
        label: parts.brandLabel,
        entity_type: "brand",
        color_role: "primary",
        points: parts.brandPoints,
        data_source: parts.blendSource,
      });
    }
    let baseline: GrowthMapSeries | undefined;
    if (parts.wanted.has("competitors")) {
      for (const competitor of [...parts.competitors].sort((left, right) => left.entityId.localeCompare(right.entityId))) {
        series.push({
          series_id: `competitor:${competitor.entityId}`,
          label: competitor.label,
          entity_type: "competitor",
          color_role: "comparison",
          points: competitor.points,
          data_source: parts.blendSource,
        });
      }
      // Scenario 4 — NO BASELINE SERIES AT ALL when there are no competitors.
      // A "median" over an empty set is a line of nulls pretending to be a
      // cohort, and a chart legend naming a baseline nobody is in.
      if (parts.competitors.length > 0) {
        baseline = {
          series_id: "competitor_baseline",
          label: "Competitor Baseline (median)",
          entity_type: "derived",
          color_role: "baseline",
          points: parts.baseline,
          data_source: parts.blendSource,
        };
        series.push(baseline);
      }
    }

    const brandEnds = firstAndLastScored(parts.brandPoints);
    const baselineEnds = baseline === undefined ? { start: null, end: null } : firstAndLastScored(baseline.points);
    return {
      granularity: parts.granularity,
      timeframe: parts.timeframe,
      series,
      engines: [...parts.engineSources].sort(([a], [b]) => a.localeCompare(b)).map(([engine_key, data_source]) => ({ engine_key, data_source })),
      milestones: parts.milestones,
      annotations: {
        data_gaps: parts.dataGaps,
        cadence_changes: parts.cadenceChanges,
        scoring_version_changes: parts.scoringVersionChanges,
      },
      summary: {
        visibility_start: brandEnds.start,
        visibility_end: brandEnds.end,
        // AC12 / STORY-136 AC9 — null across a scoring-version change: the ends were computed by two formulas.
        visibility_delta: summaryDelta(parts.brandPoints, parts.brandVersions ?? parts.brandPoints.map(() => null)),
        ...parts.bestAndWorst,
        competitor_gap_start: gapBetween(brandEnds.start, baselineEnds.start),
        competitor_gap_end: gapBetween(brandEnds.end, baselineEnds.end),
      },
      point_count: series.reduce((total, entry) => total + entry.points.length, 0),
    };
  }

  /** The project's timezone and name. NEW-E-099a — the portal supplies the timezone (its role cannot read `workspaces`). */
  private async projectSettings(tx: ClientBase, projectId: string, knownTimezone?: string): Promise<{ timezone: string; brandLabel: string }> {
    const settings =
      knownTimezone === undefined
        ? await tx.query<{ timezone: string; name: string }>(
            `SELECT w.timezone, p.name
         FROM projects p JOIN workspaces w ON w.id = p.workspace_id
        WHERE p.id = $1 AND p.deleted_at IS NULL`,
            [projectId],
          )
        : await tx.query<{ timezone: string; name: string }>(
            "SELECT $2::text AS timezone, p.name FROM projects p WHERE p.id = $1 AND p.deleted_at IS NULL",
            [projectId, knownTimezone],
          );
    const row = settings.rows[0];
    if (row === undefined) throw new NotFoundError({ message: "no such project" });
    return { timezone: row.timezone, brandLabel: row.name };
  }

  private async resolveWindow(
    tx: ClientBase,
    projectId: string,
    days: number,
    knownTimezone?: string,
    custom?: { readonly from: string; readonly to: string; readonly workspaceId: string },
  ): Promise<{ from: string; to: string; timezone: string; brandLabel: string }> {
    // The project's own timezone, for the reason the rollup gives: a project
    // in a distant zone has a different "today" than the server, and a
    // server-local window would put its captures on the wrong day.
    const { timezone, brandLabel } = await this.projectSettings(tx, projectId, knownTimezone);
    if (custom !== undefined) {
      // STORY-090: the range as asked, or a 400 naming why (retention, future, length) - never a trimmed one.
      await assertCustomRangeAllowed(tx, custom.workspaceId, timezone, custom, "growth_map");
      return { from: custom.from, to: custom.to, timezone, brandLabel };
    }
    const bounds = await tx.query<{ from: string; to: string }>(
      `SELECT to_char(today - make_interval(days => $1::int - 1), 'YYYY-MM-DD') AS from,
              to_char(today, 'YYYY-MM-DD')                                      AS to
         FROM (SELECT (now() AT TIME ZONE $2)::date AS today) t`,
      [days, timezone],
    );
    return { from: bounds.rows[0]!.from, to: bounds.rows[0]!.to, timezone, brandLabel };
  }

  /**
   * The `engine_key='all'` rows — the blend the rollup's second pass writes.
   *
   * A chart of "visibility over time" plots the blended figure; the
   * per-engine breakdown is the scorecard's job. Reading the per-engine rows
   * and re-blending them here would recompute, per day, what the rollup
   * already computed and stored.
   *
   * STORY-066 AC12 — EVERY scoring version in the window is read, and one row
   * per (entity, day) is kept by `pickScoringVersion`: the current version
   * where the day has it, otherwise the most recent older one.
   */
  private async seriesRows(
    tx: ClientBase,
    projectId: string,
    from: string,
    to: string,
    selected: readonly string[] | null,
  ): Promise<SeriesRow[]> {
    if (selected !== null) return this.narrowedSeriesRows(tx, projectId, from, to, selected);
    const result = await tx.query<SeriesRowRecord>(
      `SELECT md.entity_type,
              md.entity_id::text,
              COALESCE(c.name, p.name) AS label,
              to_char(md.metric_date, 'YYYY-MM-DD') AS metric_date,
              md.visibility_score::text,
              md.sov::text,
              md.cells_total::text,
              md.live_capture_ratio::text,
              md.scoring_version,
              (extract(epoch FROM md.computed_at) * 1000)::text AS computed_at
         FROM metric_daily md
         JOIN projects p        ON p.id = md.project_id
         LEFT JOIN competitors c ON c.id = md.entity_id AND md.entity_type = 'competitor'
        WHERE md.project_id = $1
          AND md.engine_key = $2
          AND md.metric_date BETWEEN $3::date AND $4::date
        ORDER BY md.metric_date ASC`,
      [projectId, CROSS_ENGINE_KEY, from, to],
    );
    return pickScoringVersion(result.rows.map(toSeriesRow), SCORING_VERSION);
  }

  /** The engines the project is entitled to and has enabled — the set `engines` may narrow. */
  private async entitledEngines(tx: ClientBase, projectId: string): Promise<string[]> {
    const result = await tx.query<{ engine_key: string }>(
      "SELECT engine_key FROM project_entitled_engines WHERE project_id = $1 AND enabled = true",
      [projectId],
    );
    return result.rows.map((row) => row.engine_key);
  }

  /**
   * The cross-engine blend over ONLY the selected engines.
   *
   * The same weights the rollup's second pass uses (`project_engines.weight`,
   * 1.0 where unset), applied to the per-engine rows, so a narrowing to every
   * engine reproduces the stored `all` row. An empty selection reads nothing:
   * every day is a gap, and the filter has not widened.
   *
   * STORY-066 AC12 — one scoring version per (entity, day), chosen as
   * `pickScoringVersion` chooses (current first, then the most recently
   * computed), BEFORE blending, so two versions are never averaged together.
   */
  private async narrowedSeriesRows(
    tx: ClientBase,
    projectId: string,
    from: string,
    to: string,
    selected: readonly string[],
  ): Promise<SeriesRow[]> {
    if (selected.length === 0) return [];
    const result = await tx.query<SeriesRowRecord>(
      `WITH picked AS (
         SELECT DISTINCT ON (entity_type, entity_id, metric_date) entity_type, entity_id, metric_date, scoring_version
           FROM metric_daily
          WHERE project_id = $1
            AND engine_key = ANY($2::text[])
            AND metric_date BETWEEN $4::date AND $5::date
          ORDER BY entity_type, entity_id, metric_date, (scoring_version = $3) DESC, computed_at DESC
       )
       SELECT md.entity_type,
              md.entity_id::text,
              COALESCE(max(c.name), max(p.name)) AS label,
              to_char(md.metric_date, 'YYYY-MM-DD') AS metric_date,
              (sum(md.visibility_score * COALESCE(pe.weight, 1.0)) / NULLIF(sum(COALESCE(pe.weight, 1.0)), 0))::text AS visibility_score,
              (sum(md.sov * COALESCE(pe.weight, 1.0)) / NULLIF(sum(COALESCE(pe.weight, 1.0)), 0))::text AS sov,
              sum(md.cells_total)::text AS cells_total,
              COALESCE(sum(md.live_capture_ratio * md.cells_total) / NULLIF(sum(md.cells_total), 0), 1)::text AS live_capture_ratio,
              md.scoring_version,
              (extract(epoch FROM max(md.computed_at)) * 1000)::text AS computed_at
         FROM metric_daily md
         JOIN picked k ON k.entity_type = md.entity_type AND k.entity_id = md.entity_id
                      AND k.metric_date = md.metric_date AND k.scoring_version = md.scoring_version
         JOIN projects p        ON p.id = md.project_id
         LEFT JOIN competitors c ON c.id = md.entity_id AND md.entity_type = 'competitor'
         LEFT JOIN project_engines pe ON pe.project_id = md.project_id AND pe.engine_key = md.engine_key
        WHERE md.project_id = $1
          AND md.engine_key = ANY($2::text[])
          AND md.metric_date BETWEEN $4::date AND $5::date
        GROUP BY md.entity_type, md.entity_id, md.metric_date, md.scoring_version
        ORDER BY md.metric_date ASC`,
      [projectId, selected, SCORING_VERSION, from, to],
    );
    return result.rows.map(toSeriesRow);
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
          AND ${nonMeasurementStatusSql("status")}`,
      [projectId, from, to, timezone],
    );
    return result.rows.map((row) => ({ metricDate: row.metric_date, engineKey: row.engine_key }));
  }

  /**
   * The 24h view's failures, by UTC hour. Bounded on the raw partition key, so
   * it prunes like every other 24h read (AC1).
   */
  private async failureHours(tx: ClientBase, projectId: string, fromInstant: string, toInstant: string): Promise<FailureDay[]> {
    const result = await tx.query<{ hour_index: string; engine_key: string }>(
      `SELECT DISTINCT floor(extract(epoch FROM captured_at) / 3600)::bigint::text AS hour_index, engine_key
         FROM answer_captures
        WHERE project_id = $1
          AND captured_at >= $2::timestamptz
          AND captured_at <  $3::timestamptz
          AND ${nonMeasurementStatusSql("status")}`,
      [projectId, fromInstant, toInstant],
    );
    return result.rows.map((row) => ({ metricDate: hourLabel(Number(row.hour_index) * HOUR_MS), engineKey: row.engine_key }));
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
    selected: readonly string[] | null,
  ): Promise<{ best_engine: string | null; worst_engine: string | null }> {
    // AC12 — the same version pick as the series: per (engine, day) the current version where the day has it, otherwise the most
    // recently computed older one. Filtering to the current version alone would rank nothing over a window the series plots.
    const result = await tx.query<{ engine_key: string }>(
      `WITH picked AS (
         SELECT DISTINCT ON (engine_key, metric_date) engine_key, visibility_score, cells_total
           FROM metric_daily
          WHERE project_id = $1
            AND engine_key <> $2
            AND ($6::text[] IS NULL OR engine_key = ANY($6::text[]))
            AND entity_type = 'brand'
            AND metric_date BETWEEN $4::date AND $5::date
          ORDER BY engine_key, metric_date, (scoring_version = $3) DESC, computed_at DESC
       )
       SELECT engine_key
         FROM picked
        GROUP BY engine_key
       HAVING sum(cells_total) > 0
        ORDER BY sum(visibility_score * cells_total) / sum(cells_total) DESC, engine_key ASC`,
      [projectId, CROSS_ENGINE_KEY, SCORING_VERSION, from, to, selected],
    );
    const engines = result.rows.map((row) => row.engine_key);
    // ONE ENGINE IS NEITHER BEST NOR WORST. Naming it both would put the same
    // engine on both ends of a comparison that has no other side.
    if (engines.length < 2) return { best_engine: null, worst_engine: null };
    return { best_engine: engines[0]!, worst_engine: engines[engines.length - 1]! };
  }

  /**
   * The window's pins, and AC5's cadence changes read from them.
   *
   * A cadence change is a pin `app.record_cadence_change()` (migration 0017)
   * wrote: an `annotation` from `system` titled as the trigger titles it, whose
   * detail `parseCadenceChange` reads strictly. The portal's read applies the
   * same SQL exclusions to both, so a hidden pin can never surface as an
   * annotation either.
   */
  private async milestones(
    tx: ClientBase,
    projectId: string,
    window: MilestoneWindow,
    portal?: { readonly hideCompetitors: boolean },
  ): Promise<{ milestones: Milestone[]; cadence: CadencePin[] }> {
    const result = await tx.query<{
      id: string;
      occurred_at: Date;
      local_day: string;
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
      `SELECT id::text, occurred_at, to_char((occurred_at AT TIME ZONE $4)::date, 'YYYY-MM-DD') AS local_day,
              kind, title, detail, severity, source_type, source_id::text,
              affected_engines, measured_impact, visible_in_portal
         FROM milestones
        WHERE project_id = $1
          AND (CASE WHEN $7::boolean
                    THEN occurred_at >= $2::text::timestamptz AND occurred_at < $3::text::timestamptz
                    ELSE (occurred_at AT TIME ZONE $4)::date BETWEEN $2::text::date AND $3::text::date END)
          AND ($5::boolean = false OR visible_in_portal = true)
          AND ($6::boolean = false OR (
                kind NOT LIKE 'competitor%'
                -- A completed task born of a displacement names a competitor by construction (the tasks tab drops
                -- the task; its milestone carries the task's title). Deleted tasks count: the title is still there.
                AND NOT (source_type = 'task' AND EXISTS (
                  SELECT 1 FROM tasks t WHERE t.id = milestones.source_id AND t.source_displacement_id IS NOT NULL))
              ))
        ORDER BY occurred_at ASC`,
      [
        projectId,
        window.from,
        window.to,
        window.kind === "dates" ? window.timezone : "UTC",
        portal !== undefined,
        portal?.hideCompetitors === true,
        window.kind === "instants",
      ],
    );

    const cadence: CadencePin[] = [];
    for (const row of result.rows) {
      if (row.kind !== "annotation" || row.source_type !== "system" || row.title !== CADENCE_CHANGE_TITLE) continue;
      const change = parseCadenceChange(row.detail);
      if (change !== null) cadence.push({ day: row.local_day, at: row.occurred_at.getTime(), ...change });
    }

    return {
      cadence,
      milestones: result.rows.map((row) => ({
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
      })),
    };
  }
}

/** The title `app.record_cadence_change()` (migration 0017) gives its pin. */
const CADENCE_CHANGE_TITLE = "Capture cadence changed";

interface SeriesRowRecord {
  entity_type: "brand" | "competitor";
  entity_id: string;
  label: string | null;
  metric_date: string;
  visibility_score: string;
  sov: string;
  cells_total: string;
  live_capture_ratio: string;
  scoring_version: string;
  computed_at: string;
}

function toSeriesRow(row: SeriesRowRecord): SeriesRow {
  return {
    entityType: row.entity_type,
    entityId: row.entity_id,
    label: row.label ?? row.entity_id,
    metricDate: row.metric_date,
    visibilityScore: Number(row.visibility_score),
    sov: Number(row.sov),
    cellsTotal: Number(row.cells_total),
    liveCaptureRatio: Number(row.live_capture_ratio),
    scoringVersion: row.scoring_version,
    computedAt: Number(row.computed_at),
  };
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
export function toMeasuredImpact(stored: Record<string, unknown> | null): MeasuredImpact | null {
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

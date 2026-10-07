import { Injectable, Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import type {
  CompetitorPanelQuery,
  CompetitorPanelResponse,
  CompetitorRow,
  CompetitorEngineDataSource,
} from "../../../contracts/analytics/index.js";
import { NotFoundError } from "../../api/errors/domain-errors.js";
import { DEMO_SEED_MARKER } from "../../db/seed/demo/constants.js";
import { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import { structuralLimitFrom } from "../../lib/entitlements/classification.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import {
  blendScorecards,
  EMPTY_WINDOW_METRICS,
  toScorecard,
  toWindowMetrics,
  type Scorecard,
  type WindowMetrics,
} from "../../lib/analytics/scorecard.js";
import { resolveWindow, TIMEFRAME_DAYS } from "../../lib/analytics/window.js";
import { aggregateRange, measurementStatusSql } from "../../lib/rollup/aggregate-day.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";

// NEW-C-1 — `GET /v1/projects/{id}/competitors/panel`.
//
// scoring-models §12, per (entity x engine), from stored facts only.
//
// WHY THIS DOES NOT READ COMPETITOR ROWS FROM `aggregateRange`. That
// aggregation carries `sov_weighted = 0` for every competitor row — per-entity
// share over a window is, in its own words, "EPIC-08's competitive panel, not
// this rollup". This is that panel. A competitor SoV read from there would be
// a confident zero on every row. So the shares here are computed from
// `mention_facts` directly, with the SAME denominator §2.2 defines: the sum of
// entity prominences in the cell over tracked entities AND `Other(c)`. The
// brand's SoV is computed the same way so `category_share`'s numerator and
// denominator share one definition.

/** §12 — an entity in `Other` appears in "Detected, not tracked" at this many occurrences... */
const DETECTED_MIN_APPEARANCES = 10;
/** ...within this many days (not the panel's timeframe: the rule is §12's). */
const DETECTED_WINDOW_DAYS = 30;

const logger = new Logger("competitor-panel");

interface WindowFacts {
  /** engine -> day -> cells and weights. */
  totals: Map<string, Map<string, { cells: number; weight: number }>>;
  /** ekey -> engine -> day -> measures. */
  entities: Map<string, Map<string, Map<string, { present: number; sovNum: number; promSum: number; sentW: number; rows: number }>>>;
}

interface TrackedCompetitor {
  id: string;
  name: string;
  aliases: string[];
  rootDomain: string | null;
}

/**
 * The shared CTEs. Parameters: $1 project, $2 span start, $3 span end,
 * $4 timezone, $5 engine filter (text[] or null).
 *
 * `day_cells` repeats aggregateRange's window predicate character for
 * character — same timezone conversion, same inclusive ends, same measurement
 * rule — for the reason scorecards.service.ts gives at length.
 */
const CELLS_CTE = `day_cells AS (
  SELECT c.id, c.engine_key, (c.captured_at AT TIME ZONE $4)::date AS day,
         COALESCE(pe.weight, 1.0)::double precision AS w
    FROM answer_captures c
    LEFT JOIN project_engines pe ON pe.project_id = c.project_id AND pe.engine_key = c.engine_key
   WHERE c.project_id = $1
     AND (c.captured_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
     AND ${measurementStatusSql()}
     AND ($5::text[] IS NULL OR c.engine_key = ANY($5::text[]))
)`;

const RANKED_CTE = `${CELLS_CTE},
ent AS (
  SELECT dc.id, dc.engine_key, dc.day, dc.w,
         CASE WHEN m.entity_type = 'brand' THEN 'brand'
              WHEN m.entity_type = 'competitor' AND m.entity_id IS NOT NULL THEN 'c:' || m.entity_id::text
              ELSE 'o:' || lower(m.entity_label) END AS ekey,
         max(m.prominence)::double precision                         AS prominence,
         sum(m.prominence)::double precision                         AS prom_sum,
         sum(m.prominence * m.sentiment_score)::double precision     AS sent_w,
         count(*)::int                                               AS mention_rows,
         min(m.list_position)                                        AS min_list,
         min(m.first_token_index)                                    AS min_token
    FROM day_cells dc
    JOIN mention_facts m ON m.result_id = dc.id
   GROUP BY dc.id, dc.engine_key, dc.day, dc.w, ekey
),
ranked AS (
  SELECT e.*,
         sum(e.prominence) OVER (PARTITION BY e.id)                                       AS denominator,
         row_number() OVER (PARTITION BY e.id ORDER BY e.min_list ASC NULLS LAST, e.min_token ASC) AS rk
    FROM ent e
)`;

@Injectable()
export class CompetitorPanelService {
  constructor(private readonly entitlements: EntitlementResolver) {}

  async panel(projectId: string, query: CompetitorPanelQuery): Promise<CompetitorPanelResponse> {
    const started = Date.now();
    const store = currentTenantStore();
    if (store === undefined) throw new Error("CompetitorPanelService requires an active tenant context");
    const tx = store.client;

    const window = await resolveWindow(tx, projectId, TIMEFRAME_DAYS[query.timeframe]);
    const requested = query.engines?.split(",").map((key) => key.trim()).filter((key) => key.length > 0) ?? null;

    const project = await tx.query<{ name: string }>("SELECT name FROM projects WHERE id = $1 AND deleted_at IS NULL", [
      projectId,
    ]);
    if (project.rows[0] === undefined) throw new NotFoundError({ message: "no such project" });
    const brandLabel = project.rows[0].name;

    const tracked = await this.trackedCompetitors(tx, projectId);
    const [current, prior, facts, citations, h2h, detected, sources, weights, entitled] = await Promise.all([
      aggregateRange(tx, projectId, window.from, window.to, window.timezone),
      aggregateRange(tx, projectId, window.priorFrom, window.priorTo, window.timezone),
      this.entityFacts(tx, projectId, window.priorFrom, window.to, window.timezone, requested),
      this.citationShares(tx, projectId, window.priorFrom, window.to, window.from, window.timezone, requested),
      this.headToHead(tx, projectId, window.from, window.to, window.timezone, requested),
      this.detectedNotTracked(tx, projectId, requested),
      this.dataSources(tx, projectId, window.from, window.to, window.timezone, requested),
      this.engineWeights(tx, projectId),
      this.entitledEngines(tx, projectId),
    ]);

    // The engine columns: what is entitled plus what was measured in either
    // window, narrowed by the filter — scorecards.service.ts's membership
    // rule, so the two screens name the same engines.
    const measuredEngines = new Set<string>([
      ...current.map((a) => a.engineKey),
      ...prior.map((a) => a.engineKey),
      ...facts.totals.keys(),
    ]);
    const engines = [...new Set([...entitled, ...measuredEngines])]
      .filter((key) => requested === null || requested.includes(key))
      .sort();

    const engineWeight = (engine: string): number => weights.get(engine) ?? 1;

    const brandMetrics = (aggregates: typeof current, from: string, to: string, engine: string): WindowMetrics => {
      const row = aggregates.find((a) => a.entityType === "brand" && a.engineKey === engine);
      if (row === undefined) return EMPTY_WINDOW_METRICS;
      const base = toWindowMetrics(row);
      return { ...base, shareOfVoice: this.shareOfVoice(facts, "brand", engine, from, to) };
    };

    const competitorMetrics = (
      competitor: TrackedCompetitor,
      from: string,
      to: string,
      isCurrent: boolean,
      engine: string,
    ): WindowMetrics => {
      const cellsTotal = sumDays(facts.totals.get(engine), from, to, (t) => t.cells);
      const weightTotal = sumDays(facts.totals.get(engine), from, to, (t) => t.weight);
      if (cellsTotal === 0 || weightTotal === 0) return EMPTY_WINDOW_METRICS;
      const days = facts.entities.get(`c:${competitor.id}`)?.get(engine);
      const sum = (pick: (m: { present: number; sovNum: number; promSum: number; sentW: number; rows: number }) => number): number =>
        sumDays(days, from, to, pick);
      const promSum = sum((m) => m.promSum);
      const present = sum((m) => m.present);
      return {
        presenceRate: present / cellsTotal,
        shareOfVoice: sum((m) => m.sovNum) / weightTotal,
        // §6 — null with nothing to weight; 0 is maximally negative.
        sentimentScore: promSum === 0 ? null : 50 * (sum((m) => m.sentW) / promSum + 1),
        citationShare: citations.get(`${competitor.id}|${engine}|${isCurrent ? "current" : "prior"}`) ?? null,
        renderingQuality: null,
        cellsTotal,
        cellsPresent: present,
        mentionsTotal: sum((m) => m.rows),
        citationsTotal: 0,
        citationsOwned: 0,
      };
    };

    const buildEntity = (
      metricsFor: (isCurrent: boolean, engine: string) => WindowMetrics,
    ): { perEngine: Map<string, Scorecard>; blended: Scorecard } => {
      const perEngine = new Map<string, Scorecard>();
      for (const engine of engines) perEngine.set(engine, toScorecard(engine, metricsFor(true, engine), metricsFor(false, engine)));
      const blended = blendScorecards(
        engines.map((engine) => ({ scorecard: perEngine.get(engine)!, weight: engineWeight(engine) })),
        engines.map((engine) => ({
          scorecard: toScorecard(engine, metricsFor(false, engine), EMPTY_WINDOW_METRICS),
          weight: engineWeight(engine),
        })),
      );
      return { perEngine, blended };
    };

    const brand = buildEntity((isCurrent, engine) =>
      isCurrent
        ? brandMetrics(current, window.from, window.to, engine)
        : brandMetrics(prior, window.priorFrom, window.priorTo, engine),
    );
    const competitorEntities = tracked.map((competitor) => ({
      competitor,
      ...buildEntity((isCurrent, engine) =>
        isCurrent
          ? competitorMetrics(competitor, window.from, window.to, true, engine)
          : competitorMetrics(competitor, window.priorFrom, window.priorTo, false, engine),
      ),
    }));

    // §12 — category_share(e) = SoV(e) / Σ_{k ∈ K} SoV(k), K the tracked set
    // INCLUDING the brand. Null when nothing in K has a share to divide by.
    const trackedSov = [brand.blended, ...competitorEntities.map((c) => c.blended)].map((s) => s.metrics.shareOfVoice);
    const trackedSovTotal = trackedSov.reduce<number>((total, sov) => total + (sov ?? 0), 0);
    const categoryShare = (sov: number | null): number | null =>
      sov === null || trackedSovTotal === 0 ? null : sov / trackedSovTotal;

    const variance = (ekey: string): Record<string, number | null> => {
      const result: Record<string, number | null> = {};
      for (const engine of engines) {
        const dailyTotals = facts.totals.get(engine);
        const values: number[] = [];
        for (const [day, total] of dailyTotals ?? []) {
          if (day < window.from || day > window.to || total.cells === 0 || total.weight === 0) continue;
          // A measured day on which the entity was absent is a 0, not a gap.
          values.push((facts.entities.get(ekey)?.get(engine)?.get(day)?.sovNum ?? 0) / total.weight);
        }
        result[engine] = sampleStddev(values);
      }
      return result;
    };

    const perEngineOf = (entity: { perEngine: Map<string, Scorecard> }): Record<string, number | null> =>
      Object.fromEntries(engines.map((engine) => [engine, entity.perEngine.get(engine)?.visibilityScore ?? null]));

    const rowOf = (
      entity: { perEngine: Map<string, Scorecard>; blended: Scorecard },
      identity: Pick<CompetitorRow, "entity_id" | "label" | "root_domain" | "is_brand">,
      ekey: string,
      h2hWinRate: number | null,
    ): CompetitorRow => ({
      ...identity,
      tracked: true,
      appearances: null,
      blended: entity.blended.visibilityScore,
      per_engine: perEngineOf(entity),
      sov: entity.blended.metrics.shareOfVoice,
      category_share: categoryShare(entity.blended.metrics.shareOfVoice),
      sentiment: entity.blended.metrics.sentimentScore,
      citation_share: entity.blended.metrics.citationShare,
      h2h_win_rate: h2hWinRate,
      detection_variance: variance(ekey),
      delta: entity.blended.visibilityDelta,
    });

    const brandRow = rowOf(
      brand,
      { entity_id: projectId, label: brandLabel, root_domain: null, is_brand: true },
      "brand",
      null,
    );

    const competitorRows = competitorEntities
      .map((entity) => {
        let both = 0;
        let wins = 0;
        for (const [key, value] of h2h) {
          const [competitorId, engine] = key.split("|");
          if (competitorId !== entity.competitor.id || !engines.includes(engine!)) continue;
          both += value.both;
          wins += value.wins;
        }
        // Null, not 0, when the two never appeared together: there is no
        // contest to have won or lost.
        return rowOf(
          entity,
          { entity_id: entity.competitor.id, label: entity.competitor.name, root_domain: entity.competitor.rootDomain, is_brand: false },
          `c:${entity.competitor.id}`,
          both === 0 ? null : wins / both,
        );
      })
      .sort((a, b) => compareDescNullsLast(a.blended, b.blended) || a.label.localeCompare(b.label));

    // Detected-not-tracked: every measure is null except the appearance
    // count. They have no tracked score by definition, and a 0 here would read
    // as "invisible".
    const trackedNames = new Set(
      [brandLabel, ...tracked.flatMap((c) => [c.name, ...c.aliases])].map((name) => name.toLowerCase()),
    );
    const detectedRows: CompetitorRow[] = detected
      .filter((d) => !trackedNames.has(d.key))
      .map((d) => ({
        entity_id: null,
        label: d.label,
        root_domain: null,
        is_brand: false,
        tracked: false,
        appearances: d.appearances,
        blended: null,
        per_engine: Object.fromEntries(engines.map((engine) => [engine, null])),
        sov: null,
        category_share: null,
        sentiment: null,
        citation_share: null,
        h2h_win_rate: null,
        detection_variance: Object.fromEntries(engines.map((engine) => [engine, null])),
        delta: null,
      }));

    const limit = structuralLimitFrom(
      (await this.entitlements.resolveForWorkspace(store.context.workspaceId)).entitlements["competitors.max_per_project"]
        ?.value as never,
    );

    incrementCounter("nominara_analytics_competitor_panel_requests_total", { timeframe: query.timeframe });
    // Workspace ID, never its name; no entity labels (raw engine text).
    logger.log({
      span: "analytics.competitor_panel",
      workspace_id: store.context.workspaceId,
      project_id: projectId,
      timeframe: query.timeframe,
      engines: engines.length,
      rows: 1 + competitorRows.length + detectedRows.length,
      duration_ms: Date.now() - started,
    });

    return {
      project_id: projectId,
      timeframe: query.timeframe,
      window: { from: window.from, to: window.to, timezone: window.timezone },
      engines,
      engine_data_source: Object.fromEntries(engines.map((engine) => [engine, sources.get(engine) ?? null])),
      competitors_cap: limit === undefined ? 0 : limit.kind === "unlimited" ? null : limit.limit,
      tracked_count: tracked.length,
      rows: [brandRow, ...competitorRows, ...detectedRows.sort((a, b) => (b.appearances ?? 0) - (a.appearances ?? 0) || a.label.localeCompare(b.label))],
    };
  }

  private shareOfVoice(facts: WindowFacts, ekey: string, engine: string, from: string, to: string): number | null {
    const weight = sumDays(facts.totals.get(engine), from, to, (t) => t.weight);
    if (weight === 0) return null;
    return sumDays(facts.entities.get(ekey)?.get(engine), from, to, (m) => m.sovNum) / weight;
  }

  private async trackedCompetitors(tx: ClientBase, projectId: string): Promise<TrackedCompetitor[]> {
    const result = await tx.query<{ id: string; name: string; aliases: string[]; root_domain: string | null }>(
      "SELECT id, name, aliases, root_domain FROM competitors WHERE project_id = $1 AND deleted_at IS NULL ORDER BY name",
      [projectId],
    );
    return result.rows.map((r) => ({ id: r.id, name: r.name, aliases: r.aliases, rootDomain: r.root_domain }));
  }

  /** Per-day cell totals, and per-day per-entity sums, over the whole two-window span in one pass each. */
  private async entityFacts(
    tx: ClientBase,
    projectId: string,
    from: string,
    to: string,
    timezone: string,
    engines: string[] | null,
  ): Promise<WindowFacts> {
    const params = [projectId, from, to, timezone, engines];
    const totals = await tx.query<{ day: string; engine_key: string; cells: number; weight: number }>(
      `WITH ${CELLS_CTE}
       SELECT day::text, engine_key, count(*)::int AS cells, sum(w)::double precision AS weight
         FROM day_cells GROUP BY 1, 2`,
      params,
    );
    const rows = await tx.query<{
      day: string; engine_key: string; ekey: string;
      present: number; sov_num: number | null; prom_sum: number; sent_w: number; mention_rows: number;
    }>(
      `WITH ${RANKED_CTE}
       SELECT day::text, engine_key, ekey,
              count(*)::int AS present,
              COALESCE(sum(w * prominence / NULLIF(denominator, 0)), 0)::double precision AS sov_num,
              sum(prom_sum)::double precision AS prom_sum,
              sum(sent_w)::double precision AS sent_w,
              sum(mention_rows)::int AS mention_rows
         FROM ranked
        WHERE ekey = 'brand' OR ekey LIKE 'c:%'
        GROUP BY 1, 2, 3`,
      params,
    );

    const facts: WindowFacts = { totals: new Map(), entities: new Map() };
    for (const t of totals.rows) {
      const byDay = facts.totals.get(t.engine_key) ?? new Map();
      byDay.set(t.day, { cells: t.cells, weight: t.weight });
      facts.totals.set(t.engine_key, byDay);
    }
    for (const r of rows.rows) {
      const byEngine = facts.entities.get(r.ekey) ?? new Map();
      const byDay = byEngine.get(r.engine_key) ?? new Map();
      byDay.set(r.day, {
        present: r.present,
        sovNum: r.sov_num ?? 0,
        promSum: r.prom_sum,
        sentW: r.sent_w,
        rows: r.mention_rows,
      });
      byEngine.set(r.engine_key, byDay);
      facts.entities.set(r.ekey, byEngine);
    }
    return facts;
  }

  /** §4 per competitor: the position-weighted share of resolved citations on the competitor's own domain. */
  private async citationShares(
    tx: ClientBase,
    projectId: string,
    from: string,
    to: string,
    currentFrom: string,
    timezone: string,
    engines: string[] | null,
  ): Promise<Map<string, number>> {
    const result = await tx.query<{ competitor_id: string; engine_key: string; is_current: boolean; owned: number; total: number }>(
      `WITH ${CELLS_CTE}
       SELECT k.id AS competitor_id, dc.engine_key, (dc.day >= $6::date) AS is_current,
              COALESCE(sum(f.position_weight) FILTER (
                WHERE f.domain = k.root_domain OR right(f.domain, length(k.root_domain) + 1) = '.' || k.root_domain
              ), 0)::double precision AS owned,
              sum(f.position_weight)::double precision AS total
         FROM citation_facts f
         JOIN day_cells dc ON dc.id = f.result_id
         JOIN competitors k ON k.project_id = $1 AND k.deleted_at IS NULL AND k.root_domain IS NOT NULL
        WHERE f.http_status IS NOT NULL
        GROUP BY 1, 2, 3`,
      [projectId, from, to, timezone, engines, currentFrom],
    );
    const shares = new Map<string, number>();
    for (const r of result.rows) {
      if (r.total > 0) shares.set(`${r.competitor_id}|${r.engine_key}|${r.is_current ? "current" : "prior"}`, r.owned / r.total);
    }
    return shares;
  }

  /** §12 — over the cells where BOTH appear, how often the brand has the better position in the answer. */
  private async headToHead(
    tx: ClientBase,
    projectId: string,
    from: string,
    to: string,
    timezone: string,
    engines: string[] | null,
  ): Promise<Map<string, { both: number; wins: number }>> {
    const result = await tx.query<{ competitor_id: string; engine_key: string; both: number; wins: number }>(
      `WITH ${RANKED_CTE}
       SELECT substr(k.ekey, 3) AS competitor_id, b.engine_key,
              count(*)::int AS both,
              (count(*) FILTER (WHERE b.rk < k.rk))::int AS wins
         FROM ranked b
         JOIN ranked k ON k.id = b.id AND k.ekey LIKE 'c:%'
        WHERE b.ekey = 'brand'
        GROUP BY 1, 2`,
      [projectId, from, to, timezone, engines],
    );
    return new Map(result.rows.map((r) => [`${r.competitor_id}|${r.engine_key}`, { both: r.both, wins: r.wins }]));
  }

  private async detectedNotTracked(
    tx: ClientBase,
    projectId: string,
    engines: string[] | null,
  ): Promise<{ key: string; label: string; appearances: number }[]> {
    // DISTINCT captures, not mention rows: an answer repeating a name ten
    // times is one appearance.
    const result = await tx.query<{ key: string; label: string; appearances: number }>(
      `SELECT lower(m.entity_label) AS key, min(m.entity_label) AS label,
              count(DISTINCT m.result_id)::int AS appearances
         FROM mention_facts m
        WHERE m.project_id = $1
          AND m.entity_type = 'other'
          AND m.captured_at >= now() - make_interval(days => $2::int)
          AND ($3::text[] IS NULL OR m.engine_key = ANY($3::text[]))
        GROUP BY 1
       HAVING count(DISTINCT m.result_id) >= $4::int`,
      [projectId, DETECTED_WINDOW_DAYS, engines, DETECTED_MIN_APPEARANCES],
    );
    return result.rows;
  }

  /** `demo` as soon as one capture in the window is seeded. */
  private async dataSources(
    tx: ClientBase,
    projectId: string,
    from: string,
    to: string,
    timezone: string,
    engines: string[] | null,
  ): Promise<Map<string, CompetitorEngineDataSource>> {
    const result = await tx.query<{ engine_key: string; demo: boolean }>(
      `SELECT c.engine_key, bool_or(c.normalizer_version = $6) AS demo
         FROM answer_captures c
        WHERE c.project_id = $1
          AND (c.captured_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
          AND ${measurementStatusSql()}
          AND ($5::text[] IS NULL OR c.engine_key = ANY($5::text[]))
        GROUP BY 1`,
      [projectId, from, to, timezone, engines, DEMO_SEED_MARKER],
    );
    return new Map(result.rows.map((r) => [r.engine_key, r.demo ? "demo" : "live"] as const));
  }

  private async engineWeights(tx: ClientBase, projectId: string): Promise<Map<string, number>> {
    const result = await tx.query<{ engine_key: string; weight: string }>(
      "SELECT engine_key, weight::text FROM project_engines WHERE project_id = $1",
      [projectId],
    );
    return new Map(result.rows.map((r) => [r.engine_key, Number(r.weight)]));
  }

  private async entitledEngines(tx: ClientBase, projectId: string): Promise<string[]> {
    const result = await tx.query<{ engine_key: string }>(
      "SELECT engine_key FROM project_entitled_engines WHERE project_id = $1 AND enabled = true",
      [projectId],
    );
    return result.rows.map((r) => r.engine_key);
  }
}

function sumDays<T>(
  days: Map<string, T> | undefined,
  from: string,
  to: string,
  pick: (value: T) => number,
): number {
  let total = 0;
  for (const [day, value] of days ?? []) if (day >= from && day <= to) total += pick(value);
  return total;
}

/** Sample standard deviation; null under two observations — one day has no variance to report. */
function sampleStddev(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1));
}

/** Descending comparator treating null as lowest. */
function compareDescNullsLast(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

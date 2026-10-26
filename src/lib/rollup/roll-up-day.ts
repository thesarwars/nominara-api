import type { ClientBase } from "pg";
import { aggregateDay, type DayAggregate } from "./aggregate-day.js";
import { blendAcrossEngines, SCORING_VERSION, visibilityScore } from "../scoring/index.js";

// STORY-042 — one project, one workspace-local day, into `metric_daily`.
//
// EVERY SCORE COMES FROM THE SCORING LIBRARY. `aggregate-day.ts` returns raw
// counts and sums; this file turns them into ratios and scores using the
// same functions the parse stage and the API use. §14 writes those formulas
// in SQL, and implementing it that way would put a second copy of every
// formula in the product — see the header of `aggregate-day.ts`.

/** One `metric_daily` row, before it is written. */
export interface MetricRow {
  readonly engineKey: string;
  readonly entityType: "brand" | "competitor";
  readonly entityId: string;
  readonly cellsTotal: number;
  readonly cellsPresent: number;
  readonly presenceRate: number;
  readonly sov: number;
  readonly avgProminence: number;
  readonly avgRankPosition: number | null;
  readonly mentionsTotal: number;
  readonly mentionsPositive: number;
  readonly mentionsNeutral: number;
  readonly mentionsNegative: number;
  /** NULL when the day had no mentions — never 0. See migration 0020. */
  readonly sentimentScore: number | null;
  readonly citationsTotal: number;
  readonly citationsOwned: number;
  readonly citationShare: number;
  readonly visibilityScore: number;
  /** NULL when there were no mentions on an attribute-capable engine — AC8. */
  readonly renderingQuality: number | null;
  readonly liveCaptureRatio: number;
}

/** A ratio, or null when its denominator is zero — never a zero standing in for "no data". */
function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export function toMetricRow(aggregate: DayAggregate): MetricRow {
  const presenceRate = ratio(aggregate.cellsPresent, aggregate.cellsTotal) ?? 0;
  const sov = ratio(aggregate.sovWeighted, aggregate.weightTotal) ?? 0;
  const citationShare = ratio(aggregate.citationOwnedPositionWeight, aggregate.citationPositionWeightTotal);

  // §6 — `50 · (raw + 1)`, prominence-weighted. NULL when there is nothing
  // to weight: on a 0–100 scale, 0 is maximally negative, not "no data".
  const sentimentRaw = ratio(aggregate.sentWeighted, aggregate.prominenceSum);
  const sentimentScore = sentimentRaw === null ? null : 50 * (sentimentRaw + 1);

  // §8 — prominence-weighted rendering, over attribute-capable engines only.
  const renderingRaw = ratio(aggregate.renderWeighted, aggregate.renderWeightTotal);
  const renderingQuality = aggregate.renderMentionRows === 0 || renderingRaw === null ? null : 100 * renderingRaw;

  return {
    engineKey: aggregate.engineKey,
    entityType: aggregate.entityType,
    entityId: aggregate.entityId,
    cellsTotal: aggregate.cellsTotal,
    cellsPresent: aggregate.cellsPresent,
    presenceRate,
    sov,
    avgProminence: ratio(aggregate.prominenceSum, aggregate.mentionRows) ?? 0,
    // NULL, not 0 — §11's own note applies: rank 0 does not exist, and a zero
    // would sort as the best position in anything that did not special-case it.
    avgRankPosition: ratio(aggregate.rankSum, aggregate.rankRows),
    mentionsTotal: aggregate.mentionsTotal,
    mentionsPositive: aggregate.mentionsPositive,
    mentionsNeutral: aggregate.mentionsNeutral,
    mentionsNegative: aggregate.mentionsNegative,
    sentimentScore,
    citationsTotal: aggregate.citationsTotal,
    citationsOwned: aggregate.citationsOwned,
    citationShare: citationShare ?? 0,
    // ONE implementation of §3, shared with the API and the parse stage.
    // `visibilityScore` renormalises over the components that exist, so a day
    // with no citations is scored on presence and share rather than penalised
    // for having cited nothing.
    visibilityScore: visibilityScore({ presenceRate, shareOfVoice: sov, citationShare, sentimentScore }) ?? 0,
    renderingQuality,
    liveCaptureRatio: ratio(aggregate.liveCells, aggregate.cellsTotal) ?? 1,
  };
}

/**
 * Upsert one day's rows.
 *
 * IDEMPOTENT BY PRIMARY KEY. The story's note: "Idempotent upserts are what
 * make dirty-date reprocessing free. Without them, reprocessing would need to
 * detect and reverse the previous contribution, which is the kind of
 * arithmetic that produces slow drift."
 *
 * `scoring_version` IS PART OF THE KEY, so two versions coexist per day and a
 * cut-over never rewrites history — AC12.
 */
export async function upsertMetricRows(
  tx: ClientBase,
  workspaceId: string,
  projectId: string,
  metricDate: string,
  rows: readonly MetricRow[],
): Promise<void> {
  for (const row of rows) {
    await tx.query(
      `INSERT INTO metric_daily
         (workspace_id, project_id, engine_key, entity_type, entity_id, metric_date,
          cells_total, cells_present, presence_rate, sov, avg_prominence, avg_rank_position,
          mentions_total, mentions_positive, mentions_neutral, mentions_negative, sentiment_score,
          citations_total, citations_owned, citation_share, visibility_score, rendering_quality,
          live_capture_ratio, scoring_version, computed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24, now())
       ON CONFLICT (project_id, engine_key, entity_type, entity_id, metric_date, scoring_version)
       DO UPDATE SET
         cells_total = EXCLUDED.cells_total, cells_present = EXCLUDED.cells_present,
         presence_rate = EXCLUDED.presence_rate, sov = EXCLUDED.sov,
         avg_prominence = EXCLUDED.avg_prominence, avg_rank_position = EXCLUDED.avg_rank_position,
         mentions_total = EXCLUDED.mentions_total, mentions_positive = EXCLUDED.mentions_positive,
         mentions_neutral = EXCLUDED.mentions_neutral, mentions_negative = EXCLUDED.mentions_negative,
         sentiment_score = EXCLUDED.sentiment_score, citations_total = EXCLUDED.citations_total,
         citations_owned = EXCLUDED.citations_owned, citation_share = EXCLUDED.citation_share,
         visibility_score = EXCLUDED.visibility_score, rendering_quality = EXCLUDED.rendering_quality,
         live_capture_ratio = EXCLUDED.live_capture_ratio, computed_at = now()`,
      [
        workspaceId,
        projectId,
        row.engineKey,
        row.entityType,
        row.entityId,
        metricDate,
        row.cellsTotal,
        row.cellsPresent,
        row.presenceRate,
        row.sov,
        row.avgProminence,
        row.avgRankPosition,
        row.mentionsTotal,
        row.mentionsPositive,
        row.mentionsNeutral,
        row.mentionsNegative,
        row.sentimentScore,
        row.citationsTotal,
        row.citationsOwned,
        row.citationShare,
        row.visibilityScore,
        row.renderingQuality,
        row.liveCaptureRatio,
        SCORING_VERSION,
      ],
    );
  }
}

/** §14 — `engine_key='all'`, from the per-engine rows using `w_e`. */
export const CROSS_ENGINE_KEY = "all";

/**
 * The second pass.
 *
 * The story explains why it is a second pass rather than an inline
 * computation: "the per-engine rows are the inputs, and computing both in one
 * pass would either duplicate work or produce a blended figure from partial
 * data."
 *
 * Reading the rows back rather than blending the in-memory ones is
 * deliberate: after a dirty-date reprocess only SOME engines may have been
 * recomputed, and the blended row has to reflect every engine's current
 * value, not just the ones this pass touched.
 */
export async function upsertCrossEngineRows(
  tx: ClientBase,
  workspaceId: string,
  projectId: string,
  metricDate: string,
): Promise<void> {
  const perEngine = await tx.query<{
    entity_type: "brand" | "competitor";
    entity_id: string;
    engine_key: string;
    weight: string;
    cells_total: string;
    cells_present: string;
    mentions_total: string;
    mentions_positive: string;
    mentions_neutral: string;
    mentions_negative: string;
    citations_total: string;
    citations_owned: string;
    visibility_score: string;
    sentiment_score: string | null;
    rendering_quality: string | null;
    live_cells: string;
    sov_weighted: string;
    cit_owned_pw: string;
    cit_pw_total: string;
  }>(
    `SELECT md.entity_type, md.entity_id::text, md.engine_key,
            COALESCE(pe.weight, 1.0)::text                              AS weight,
            md.cells_total::text, md.cells_present::text,
            md.mentions_total::text, md.mentions_positive::text,
            md.mentions_neutral::text, md.mentions_negative::text,
            md.citations_total::text, md.citations_owned::text,
            md.visibility_score::text, md.sentiment_score::text, md.rendering_quality::text,
            (md.live_capture_ratio * md.cells_total)::text              AS live_cells,
            (md.sov * COALESCE(pe.weight, 1.0))::text                   AS sov_weighted,
            (md.citation_share * md.citations_total)::text              AS cit_owned_pw,
            md.citations_total::text                                    AS cit_pw_total
       FROM metric_daily md
       LEFT JOIN project_engines pe
              ON pe.project_id = md.project_id AND pe.engine_key = md.engine_key
      WHERE md.project_id = $1 AND md.metric_date = $2::date
        AND md.scoring_version = $3 AND md.engine_key <> $4`,
    [projectId, metricDate, SCORING_VERSION, CROSS_ENGINE_KEY],
  );

  const byEntity = new Map<string, typeof perEngine.rows>();
  for (const row of perEngine.rows) {
    const key = `${row.entity_type}:${row.entity_id}`;
    byEntity.set(key, [...(byEntity.get(key) ?? []), row]);
  }

  for (const [, rows] of byEntity) {
    const cellsPresent = rows.reduce((total, row) => total + Number(row.cells_present), 0);
    const mentionsTotal = rows.reduce((total, row) => total + Number(row.mentions_total), 0);
    const blended = blendEngineParts(
      rows.map((row) => ({
        weight: Number(row.weight),
        cellsTotal: Number(row.cells_total),
        sovWeighted: Number(row.sov_weighted),
        visibilityScore: Number(row.visibility_score),
        liveCells: Number(row.live_cells),
      })),
    );
    const cellsTotal = blended.cellsTotal;

    // Weighted means, over the engines that HAVE a value. An engine whose
    // sentiment is null contributed no mentions, and averaging it in as zero
    // would drag the blended figure toward "maximally negative".
    const sentimentRows = rows.filter((row) => row.sentiment_score !== null);
    const renderingRows = rows.filter((row) => row.rendering_quality !== null);

    await upsertMetricRows(tx, workspaceId, projectId, metricDate, [
      {
        engineKey: CROSS_ENGINE_KEY,
        entityType: rows[0]!.entity_type,
        entityId: rows[0]!.entity_id,
        cellsTotal,
        cellsPresent,
        presenceRate: cellsTotal === 0 ? 0 : cellsPresent / cellsTotal,
        sov: blended.sov,
        avgProminence: weightedMean(rows.map((row) => ({ value: Number(row.visibility_score), weight: Number(row.weight) }))) ?? 0,
        avgRankPosition: null,
        mentionsTotal,
        mentionsPositive: rows.reduce((total, row) => total + Number(row.mentions_positive), 0),
        mentionsNeutral: rows.reduce((total, row) => total + Number(row.mentions_neutral), 0),
        mentionsNegative: rows.reduce((total, row) => total + Number(row.mentions_negative), 0),
        sentimentScore: weightedMean(
          sentimentRows.map((row) => ({ value: Number(row.sentiment_score), weight: Number(row.weight) })),
        ),
        citationsTotal: rows.reduce((total, row) => total + Number(row.citations_total), 0),
        citationsOwned: rows.reduce((total, row) => total + Number(row.citations_owned), 0),
        citationShare:
          rows.reduce((total, row) => total + Number(row.cit_pw_total), 0) === 0
            ? 0
            : rows.reduce((total, row) => total + Number(row.cit_owned_pw), 0) /
              rows.reduce((total, row) => total + Number(row.cit_pw_total), 0),
        // §3's own cross-engine formula, from the scoring library.
        visibilityScore: blended.visibilityScore,
        renderingQuality: weightedMean(
          renderingRows.map((row) => ({ value: Number(row.rendering_quality), weight: Number(row.weight) })),
        ),
        liveCaptureRatio: blended.liveCaptureRatio,
      },
    ]);
  }
}

/** One engine's contribution to a cross-engine blend. `sovWeighted` is `sov · weight`. */
export interface EnginePart {
  readonly weight: number;
  readonly cellsTotal: number;
  readonly sovWeighted: number;
  readonly visibilityScore: number;
  readonly liveCells: number;
}

/**
 * §14's cross-engine blend of the four figures a chart point carries, from the
 * per-engine figures. ONE implementation: the stored `engine_key='all'` row
 * and STORY-066's hourly view (which has no stored row) both call it, so an
 * hour and a day can never be blended by two different formulas.
 */
export function blendEngineParts(parts: readonly EnginePart[]): {
  cellsTotal: number;
  sov: number;
  visibilityScore: number;
  liveCaptureRatio: number;
} {
  const weightTotal = parts.reduce((total, part) => total + part.weight, 0);
  const cellsTotal = parts.reduce((total, part) => total + part.cellsTotal, 0);
  const liveCells = parts.reduce((total, part) => total + part.liveCells, 0);
  return {
    cellsTotal,
    sov: weightTotal === 0 ? 0 : parts.reduce((total, part) => total + part.sovWeighted, 0) / weightTotal,
    // §3's own cross-engine formula, from the scoring library.
    visibilityScore: blendAcrossEngines(parts.map((part) => ({ score: part.visibilityScore, engineWeight: part.weight }))) ?? 0,
    liveCaptureRatio: cellsTotal === 0 ? 1 : liveCells / cellsTotal,
  };
}

function weightedMean(parts: readonly { value: number; weight: number }[]): number | null {
  const weightTotal = parts.reduce((total, part) => total + part.weight, 0);
  if (parts.length === 0 || weightTotal === 0) return null;
  return parts.reduce((total, part) => total + part.value * part.weight, 0) / weightTotal;
}

/**
 * Roll up one project for one workspace-local day, both passes.
 *
 * Takes a transaction and never opens one — the caller owns the boundary, and
 * the caller is the worker, which advisory-locks first.
 */
export async function rollUpDay(
  tx: ClientBase,
  workspaceId: string,
  projectId: string,
  metricDate: string,
  timezone: string,
): Promise<number> {
  const aggregates = await aggregateDay(tx, projectId, metricDate, timezone);
  await upsertMetricRows(tx, workspaceId, projectId, metricDate, aggregates.map(toMetricRow));
  await upsertCrossEngineRows(tx, workspaceId, projectId, metricDate);
  return aggregates.length;
}

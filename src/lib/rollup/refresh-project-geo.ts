import type { ClientBase } from "pg";
import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { GeoAnalysisWrite } from "../../../contracts/analytics/index.js";
import { writeGeoAnalysis } from "../geo/persist-analysis.js";
import { rankGeoLevers } from "../geo/lever-rank.js";
import { buildSentiment, loadSentimentInput } from "../geo/sentiment.js";
import { buildStructure, loadStructureInput, windowStartFor } from "../geo/structure.js";
import { incrementCounter, observeHistogram } from "../telemetry/metrics.js";

// STORY-060/061 — recompute a project's GEO analyses and persist them to
// `geo_analyses` (through the one write path, `writeGeoAnalysis`). `structure`
// (A3) and `sentiment` (A6) exist so far; the other analyses join this
// function in their own stories. Nothing here is metered: no credit guard, no ledger.

const logger = new Logger("rollup.geo");
const tracer = trace.getTracer("nominara.geo-refresh");

/** The canonical "current" window, the same one the dashboards read. */
export const GEO_WINDOW_DAYS = 30;

export interface RefreshProjectGeoOptions {
  /** The window ends on this day (UTC, inclusive). Defaults to now. */
  asOf?: Date;
  windowDays?: 7 | 30 | 90;
}

/** Recompute A3 and A6 for one project; a recompute of the same window replaces each row. Returns A3's. */
export async function refreshProjectGeo(
  tx: ClientBase,
  projectId: string,
  options: RefreshProjectGeoOptions = {},
): Promise<GeoAnalysisWrite> {
  const windowDays = options.windowDays ?? GEO_WINDOW_DAYS;
  const started = performance.now();
  const input = await loadStructureInput(tx, projectId, windowStartFor(options.asOf ?? new Date(), windowDays), windowDays);
  const { write } = buildStructure(input);
  const persisted = await writeGeoAnalysis(tx, projectId, write);
  incrementCounter("nominara_geo_structure_recompute_total", { sufficient: String(persisted.sufficient) });
  // No span library exists in this codebase yet; the duration is logged with the counter's labels.
  // The log carries counts and the window, never answer text and never the workspace's name.
  logger.log({
    event: "geo_structure_recomputed",
    project_id: projectId,
    metric: "nominara_geo_structure_recompute_duration_ms",
    value: Math.round(performance.now() - started),
    sufficient: persisted.sufficient,
    answers: persisted.evidence_cells,
    window_days: windowDays,
  });

  // STORY-061 — A6 sentiment drivers, same window, same transaction.
  const sentimentStarted = performance.now();
  const sentiment = await writeGeoAnalysis(
    tx,
    projectId,
    buildSentiment(await loadSentimentInput(tx, projectId, windowStartFor(options.asOf ?? new Date(), windowDays), windowDays)).write,
  );
  incrementCounter("nominara_geo_sentiment_recompute_total", { sufficient: String(sentiment.sufficient) });
  logger.log({
    event: "geo_sentiment_recomputed",
    project_id: projectId,
    metric: "nominara_geo_sentiment_recompute_duration_ms",
    value: Math.round(performance.now() - sentimentStarted),
    sufficient: sentiment.sufficient,
    brand_mentions: sentiment.evidence_cells,
    window_days: windowDays,
  });

  // STORY-062 / NEW-C-13 — rank the Top Three Levers across every analysis persisted for this window.
  await rankGeoLevers(tx, projectId, persisted.window_start, windowDays);
  return persisted;
}

/** Every window the read endpoints serve (7d, 30d, 90d). A read of a window never computes one. */
export const GEO_WINDOWS: readonly (7 | 30 | 90)[] = [7, 30, 90];

/**
 * The freshness objective (edge-cases-and-slos #28): GEO analyses recompute daily and are visible within 30 minutes of the
 * trigger, p95 per project, read from `geo_analyses.computed_at`. The production p95 is observed on
 * `nominara_geo_recompute_freshness_seconds`; the integration spec proves a fixture project fits.
 */
export const GEO_FRESHNESS_OBJECTIVE_SECONDS = 30 * 60;

/**
 * Recompute every analysis for all three served windows, so no timeframe on the read side answers "not computed yet".
 * One span per project, and one freshness observation: seconds from the trigger (this call) until the last window's rows are
 * written. The line carries the project ID and counts, never the workspace's name and never answer text.
 */
export async function refreshProjectGeoWindows(
  tx: ClientBase,
  projectId: string,
  options: Omit<RefreshProjectGeoOptions, "windowDays"> = {},
): Promise<GeoAnalysisWrite[]> {
  return tracer.startActiveSpan("geo.refresh", async (span) => {
    const started = performance.now();
    try {
      const out: GeoAnalysisWrite[] = [];
      for (const windowDays of GEO_WINDOWS) out.push(await refreshProjectGeo(tx, projectId, { ...options, windowDays }));
      span.setAttribute("nominara.geo_refresh.windows", out.length);
      observeHistogram("nominara_geo_recompute_freshness_seconds", Math.round(((performance.now() - started) / 1000) * 1000) / 1000, {
        project_id: projectId,
        windows: out.length,
      });
      return out;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

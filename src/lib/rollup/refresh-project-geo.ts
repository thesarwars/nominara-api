import type { ClientBase } from "pg";
import { Logger } from "@nestjs/common";
import type { GeoAnalysisWrite } from "../../../contracts/analytics/index.js";
import { writeGeoAnalysis } from "../geo/persist-analysis.js";
import { buildStructure, loadStructureInput, windowStartFor } from "../geo/structure.js";
import { incrementCounter } from "../telemetry/metrics.js";

// STORY-060 — recompute a project's GEO analyses and persist them to
// `geo_analyses` (through the one write path, `writeGeoAnalysis`). Only
// `structure` (A3) exists so far; the other analyses join this function in
// their own stories. Nothing here is metered: no credit guard, no ledger.

const logger = new Logger("rollup.geo");

/** The canonical "current" window, the same one the dashboards read. */
export const GEO_WINDOW_DAYS = 30;

export interface RefreshProjectGeoOptions {
  /** The window ends on this day (UTC, inclusive). Defaults to now. */
  asOf?: Date;
  windowDays?: 7 | 30 | 90;
}

/** Recompute A3 for one project; a recompute of the same window replaces its row. */
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
  return persisted;
}

/** Every window the read endpoints serve (7d, 30d, 90d). A read of a window never computes one. */
export const GEO_WINDOWS: readonly (7 | 30 | 90)[] = [7, 30, 90];

/** Recompute A3 for all three served windows, so no timeframe on the read side answers "not computed yet". */
export async function refreshProjectGeoWindows(
  tx: ClientBase,
  projectId: string,
  options: Omit<RefreshProjectGeoOptions, "windowDays"> = {},
): Promise<GeoAnalysisWrite[]> {
  const out: GeoAnalysisWrite[] = [];
  for (const windowDays of GEO_WINDOWS) out.push(await refreshProjectGeo(tx, projectId, { ...options, windowDays }));
  return out;
}

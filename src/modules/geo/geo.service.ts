import { Injectable, Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import {
  type GeoAnalysis,
  type GeoAnalysisWrite,
  type GeoDigest,
  type GeoInsightsQuery,
  type GeoSlug,
  geoSentimentDetailSchema,
} from "../../../contracts/analytics/index.js";
import { NotFoundError } from "../../api/errors/domain-errors.js";
import { composeDigest, summarize, validFindings, type StoredAnalysis } from "../../lib/geo/insights.js";
import { writeGeoAnalysis } from "../../lib/geo/persist-analysis.js";
import { buildStructure, loadStructureInput } from "../../lib/geo/structure.js";
import { SCORING_VERSION } from "../../lib/scoring/index.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";

// STORY-062 — the single owner of `geo_analyses`.
//
// READS ARE PERSISTED ROWS ONLY. Nothing here computes an analysis, calls an
// engine or embedding provider, or holds a transaction across an await on
// anything but Postgres. Free and unmetered: no credit guard, no meter.

const WINDOW_DAYS: Readonly<Record<GeoInsightsQuery["timeframe"], number>> = Object.freeze({ "7d": 7, "30d": 30, "90d": 90 });

interface Row {
  analysis: GeoSlug;
  score: string | null;
  evidence_cells: number;
  evidence_passages: number;
  sufficient: boolean;
  suppression_reason: string | null;
  findings: unknown[];
  lever_rank: number | null;
  window_days: number;
  window_start: string;
}

@Injectable()
export class GeoService {
  private readonly logger = new Logger("geo.insights");

  /**
   * The ONE write path every analysis persists through. Validates against the
   * write contract (seven slugs — the fan-out analysis is unwritable; every
   * finding evidenced and terminating in a task rule or a no-action verdict;
   * an insufficient analysis publishes nothing but its reason), then upserts
   * on the composite key so a recompute REPLACES.
   */
  async persistAnalysis(projectId: string, input: unknown): Promise<GeoAnalysisWrite> {
    const a = await writeGeoAnalysis(this.tx(), projectId, input);
    // Workspace ID is not available here by design: the log carries the analysis and window only.
    this.logger.log({ event: "geo_analysis_persisted", analysis: a.analysis, window_days: a.window_days, findings: a.findings.length });
    return a;
  }

  async digest(projectId: string, query: GeoInsightsQuery): Promise<GeoDigest> {
    const days = WINDOW_DAYS[query.timeframe];
    const rows = await this.latestRows(projectId, days);
    incrementCounter("nominara_geo_digest_read_total", { sufficient: String(rows.some((r) => r.sufficient)) });
    // Levers' tasks are null until the task engine can resolve a rule code to
    // an open task: STORY-062 says a lever links to one; the contract allows null.
    return composeDigest(rows, days, () => null);
  }

  async analysis(projectId: string, slug: GeoSlug, query: GeoInsightsQuery): Promise<GeoAnalysis> {
    const days = WINDOW_DAYS[query.timeframe];
    const row = (await this.latestRows(projectId, days, slug))[0] ?? null;
    incrementCounter("nominara_geo_analysis_read_total", { analysis: slug });
    const detail = await this.detailFor(projectId, slug, row);
    const sentiment = slug === "sentiment" ? geoSentimentDetailSchema.safeParse(detail) : null;
    const actions =
      sentiment?.success === true
        ? // One action per distinct reason class: a title, and no task id until the task engine exists.
          sentiment.data.reason_classes.map((rc) => ({ label: rc.task_title, task_title: rc.task_title, task_id: null, href: null, engines: [] as string[] }))
        : row !== null && row.sufficient
        ? validFindings(row)
            .filter((f) => f.task_rule_code !== undefined)
            .map((f) => ({ label: f.headline, task_title: null, task_id: null, href: null, engines: [] as string[] }))
        : [];
    return { summary: summarize(slug, row, days), detail, actions };
  }

  /**
   * Per-slug detail. `structure` (STORY-060) has a builder over the stored
   * window's facts; `sentiment` (STORY-061) is read back from the finding the
   * rollup persisted it on, and NEVER recomputed; the rest stay null until
   * their own story. A suppressed analysis has no detail: the
   * suppression reason is the whole answer. The detail is a deterministic
   * aggregate of the stored window's facts through the same function the
   * rollup used, so the two cannot disagree about what the window contains.
   */
  private async detailFor(projectId: string, slug: GeoSlug, row: StoredAnalysis | null): Promise<GeoAnalysis["detail"]> {
    if (slug === "sentiment") {
      if (row === null || !row.sufficient) return null;
      return validFindings(row).find((f) => f.sentiment !== undefined)?.sentiment ?? null;
    }
    if (slug !== "structure" || row === null || !row.sufficient || row.windowStart === undefined) return null;
    const input = await loadStructureInput(this.tx(), projectId, row.windowStart, row.windowDays as 7 | 30 | 90);
    return buildStructure(input).detail;
  }

  /** The newest row per analysis for the window, current scoring version only. */
  private async latestRows(projectId: string, windowDays: number, slug?: GeoSlug): Promise<StoredAnalysis[]> {
    const tx = this.tx();
    const project = await tx.query("SELECT 1 FROM projects WHERE id = $1 AND deleted_at IS NULL", [projectId]);
    if (project.rowCount === 0) throw new NotFoundError({ message: "no such project" });
    const res = await tx.query<Row>(
      `SELECT DISTINCT ON (analysis)
              analysis, score::text AS score, evidence_cells, evidence_passages, sufficient,
              suppression_reason, findings, lever_rank, window_days, window_start::text AS window_start
         FROM geo_analyses
        WHERE project_id = $1 AND window_days = $2 AND scoring_version = $3
          AND ($4::text IS NULL OR analysis = $4)
        ORDER BY analysis, window_start DESC, computed_at DESC`,
      [projectId, windowDays, SCORING_VERSION, slug ?? null],
    );
    return res.rows.map((r) => ({
      analysis: r.analysis,
      score: r.score === null ? null : Number(r.score),
      evidenceCells: r.evidence_cells,
      evidencePassages: r.evidence_passages,
      sufficient: r.sufficient,
      suppressionReason: r.suppression_reason,
      findings: r.findings,
      leverRank: r.lever_rank,
      windowDays: r.window_days,
      windowStart: r.window_start,
    }));
  }

  private tx(): ClientBase {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("GeoService requires an active tenant context");
    return store.client;
  }
}

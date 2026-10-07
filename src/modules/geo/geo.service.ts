import { Injectable, Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import {
  geoAnalysisWriteSchema,
  type GeoAnalysis,
  type GeoAnalysisWrite,
  type GeoDigest,
  type GeoInsightsQuery,
  type GeoSlug,
} from "../../../contracts/analytics/index.js";
import { NotFoundError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { composeDigest, summarize, validFindings, type StoredAnalysis } from "../../lib/geo/insights.js";
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
    const parsed = geoAnalysisWriteSchema.safeParse(input);
    if (!parsed.success) {
      incrementCounter("nominara_geo_analysis_rejected_total", { reason: "invalid" });
      throw new ValidationFailedError({
        message: "the analysis violates the geo_analyses write contract",
        details: { issues: parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })) },
      });
    }
    const a = parsed.data;
    const tx = this.tx();
    const result = await tx.query(
      `INSERT INTO geo_analyses
         (workspace_id, project_id, analysis, window_start, window_days, score, score_label,
          evidence_cells, evidence_passages, sufficient, suppression_reason, findings, lever_rank,
          scoring_version, computed_at)
       SELECT p.workspace_id, p.id, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, now()
         FROM projects p WHERE p.id = $1 AND p.deleted_at IS NULL
       ON CONFLICT (project_id, analysis, window_start, window_days, scoring_version) DO UPDATE SET
         score = EXCLUDED.score, score_label = EXCLUDED.score_label,
         evidence_cells = EXCLUDED.evidence_cells, evidence_passages = EXCLUDED.evidence_passages,
         sufficient = EXCLUDED.sufficient, suppression_reason = EXCLUDED.suppression_reason,
         findings = EXCLUDED.findings, lever_rank = EXCLUDED.lever_rank, computed_at = now()`,
      [
        projectId, a.analysis, a.window_start, a.window_days, a.score, a.score_label,
        a.evidence_cells, a.evidence_passages, a.sufficient, a.suppression_reason,
        JSON.stringify(a.findings), a.lever_rank, SCORING_VERSION,
      ],
    );
    if (result.rowCount === 0) throw new NotFoundError({ message: "no such project" });
    incrementCounter("nominara_geo_analysis_persisted_total", { analysis: a.analysis, sufficient: String(a.sufficient) });
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
    const actions =
      row !== null && row.sufficient
        ? validFindings(row)
            .filter((f) => f.task_rule_code !== undefined)
            .map((f) => ({ label: f.headline, task_title: null, task_id: null, href: null, engines: [] as string[] }))
        : [];
    return { summary: summarize(slug, row, days), detail: null, actions };
  }

  /** The newest row per analysis for the window, current scoring version only. */
  private async latestRows(projectId: string, windowDays: number, slug?: GeoSlug): Promise<StoredAnalysis[]> {
    const tx = this.tx();
    const project = await tx.query("SELECT 1 FROM projects WHERE id = $1 AND deleted_at IS NULL", [projectId]);
    if (project.rowCount === 0) throw new NotFoundError({ message: "no such project" });
    const res = await tx.query<Row>(
      `SELECT DISTINCT ON (analysis)
              analysis, score::text AS score, evidence_cells, evidence_passages, sufficient,
              suppression_reason, findings, lever_rank, window_days
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
    }));
  }

  private tx(): ClientBase {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("GeoService requires an active tenant context");
    return store.client;
  }
}

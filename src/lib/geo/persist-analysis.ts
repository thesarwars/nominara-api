import type { ClientBase } from "pg";
import { geoAnalysisWriteSchema, type GeoAnalysisWrite } from "../../../contracts/analytics/index.js";
import { NotFoundError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { SCORING_VERSION } from "../scoring/index.js";
import { incrementCounter } from "../telemetry/metrics.js";

// STORY-062 — the ONE write path into `geo_analyses`, lifted out of
// GeoService (STORY-060) so the rollup (`refresh-project-geo.ts`), which has
// an explicit transaction and no Nest container, writes through the SAME
// validation and upsert as the service. GeoService.persistAnalysis delegates
// here; there is no second INSERT into this table anywhere.

/**
 * Validates against the write contract (seven slugs — the fan-out analysis is
 * unwritable; every finding evidenced and terminating in a task rule or a
 * no-action verdict; an insufficient analysis publishes nothing but its
 * reason), then upserts on the composite key so a recompute REPLACES.
 */
export async function writeGeoAnalysis(tx: ClientBase, projectId: string, input: unknown): Promise<GeoAnalysisWrite> {
  const parsed = geoAnalysisWriteSchema.safeParse(input);
  if (!parsed.success) {
    incrementCounter("nominara_geo_analysis_rejected_total", { reason: "invalid" });
    throw new ValidationFailedError({
      message: "the analysis violates the geo_analyses write contract",
      details: { issues: parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })) },
    });
  }
  const a = parsed.data;
  const result = await tx.query(
    `INSERT INTO geo_analyses
       (workspace_id, project_id, analysis, window_start, window_days, score, score_label,
        evidence_cells, evidence_passages, sufficient, suppression_reason, findings, lever_rank,
        scoring_version, computed_at)
     SELECT p.workspace_id, p.id, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, clock_timestamp()
       FROM projects p WHERE p.id = $1 AND p.deleted_at IS NULL
     ON CONFLICT (project_id, analysis, window_start, window_days, scoring_version) DO UPDATE SET
       score = EXCLUDED.score, score_label = EXCLUDED.score_label,
       evidence_cells = EXCLUDED.evidence_cells, evidence_passages = EXCLUDED.evidence_passages,
       sufficient = EXCLUDED.sufficient, suppression_reason = EXCLUDED.suppression_reason,
       findings = EXCLUDED.findings, lever_rank = EXCLUDED.lever_rank, computed_at = clock_timestamp()`,
    [
      projectId, a.analysis, a.window_start, a.window_days, a.score, a.score_label,
      a.evidence_cells, a.evidence_passages, a.sufficient, a.suppression_reason,
      JSON.stringify(a.findings), a.lever_rank, SCORING_VERSION,
    ],
  );
  if (result.rowCount === 0) throw new NotFoundError({ message: "no such project" });
  incrementCounter("nominara_geo_analysis_persisted_total", { analysis: a.analysis, sufficient: String(a.sufficient) });
  return a;
}

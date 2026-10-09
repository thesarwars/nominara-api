import { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { geoFindingSchema, geoSlugSchema, type GeoFinding, type GeoSlug } from "../../../contracts/analytics/index.js";
import { SCORING_VERSION } from "../scoring/index.js";
import { incrementCounter } from "../telemetry/metrics.js";

// NEW-C-13 (STORY-062) — the Top Three Levers. After a project's analyses are
// recomputed for a window, ONE pass ranks them against each other and stamps
// `geo_analyses.lever_rank` (1..3) plus the winning finding's `lever_rank`, so
// the digest and the Overview read the persisted snapshot and never rank on read.
//
// IMPACT has no formula in the reference, so it is defined here, in order:
//   1. the severity of the analysis's best ACTIONABLE finding;
//   2. the analysis's evidence base (cells), larger first;
//   3. the fixed slug order, so the result never depends on input order.
// A finding that needs no action is never a lever ("never a generic checklist"),
// and neither is anything in an insufficient analysis. One lever per analysis.

const logger = new Logger("geo.levers");
const MAX_LEVERS = 3;
const SEVERITY_WEIGHT: Record<GeoFinding["severity"], number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
const SLUG_ORDER: readonly GeoSlug[] = geoSlugSchema.options;

export interface LeverRow {
  analysis: GeoSlug;
  sufficient: boolean;
  evidenceCells: number;
  findings: GeoFinding[];
}

export interface LeverAssignment {
  analysis: GeoSlug;
  leverRank: 1 | 2 | 3 | null;
  /** The input findings, any stale `lever_rank` removed and the winning finding's set. */
  findings: GeoFinding[];
}

const stripRank = (f: GeoFinding): GeoFinding => {
  const { lever_rank: _stale, ...rest } = f;
  return rest;
};

/** Pure. Input is not mutated. */
export function rankLevers(rows: readonly LeverRow[]): LeverAssignment[] {
  const candidates: { row: LeverRow; winner: number }[] = [];
  for (const row of rows) {
    if (!row.sufficient) continue;
    let winner = -1;
    row.findings.forEach((f, i) => {
      if (f.task_rule_code === undefined) return;
      if (winner === -1 || SEVERITY_WEIGHT[f.severity] > SEVERITY_WEIGHT[row.findings[winner]!.severity]) winner = i;
    });
    if (winner !== -1) candidates.push({ row, winner });
  }
  const impact = (c: { row: LeverRow; winner: number }): number => SEVERITY_WEIGHT[c.row.findings[c.winner]!.severity];
  candidates.sort(
    (a, b) =>
      impact(b) - impact(a) ||
      b.row.evidenceCells - a.row.evidenceCells ||
      SLUG_ORDER.indexOf(a.row.analysis) - SLUG_ORDER.indexOf(b.row.analysis),
  );
  const promoted = new Map(candidates.slice(0, MAX_LEVERS).map((c, i) => [c.row.analysis, { rank: (i + 1) as 1 | 2 | 3, winner: c.winner }]));

  return rows.map((row) => {
    const p = promoted.get(row.analysis);
    return {
      analysis: row.analysis,
      leverRank: p?.rank ?? null,
      findings: row.findings.map((f, i) => (p !== undefined && i === p.winner ? { ...stripRank(f), lever_rank: p.rank } : stripRank(f))),
    };
  });
}

/**
 * Rank the persisted analyses of one project window and write back only the
 * rows whose lever changed. Runs in the caller's tenant transaction, so RLS
 * confines it to the workspace's own rows; a project that is not visible has
 * no rows and nothing changes. Free and unmetered.
 */
export async function rankGeoLevers(tx: ClientBase, projectId: string, windowStart: string, windowDays: number): Promise<void> {
  const res = await tx.query<{
    analysis: string;
    sufficient: boolean;
    evidence_cells: number;
    findings: unknown;
    lever_rank: number | null;
  }>(
    `SELECT analysis, sufficient, evidence_cells, findings, lever_rank
       FROM geo_analyses
      WHERE project_id = $1 AND window_start = $2::date AND window_days = $3 AND scoring_version = $4`,
    [projectId, windowStart, windowDays, SCORING_VERSION],
  );

  const rows: LeverRow[] = [];
  const before = new Map<GeoSlug, { findings: unknown; leverRank: number | null }>();
  for (const r of res.rows) {
    const slug = geoSlugSchema.safeParse(r.analysis);
    const findings = geoFindingSchema.array().safeParse(r.findings);
    // Fail closed: a row that no longer satisfies the contract is left alone, not ranked.
    if (!slug.success || !findings.success) continue;
    rows.push({ analysis: slug.data, sufficient: r.sufficient, evidenceCells: r.evidence_cells, findings: findings.data });
    before.set(slug.data, { findings: r.findings, leverRank: r.lever_rank });
  }

  let promoted = 0;
  for (const a of rankLevers(rows)) {
    if (a.leverRank !== null) promoted += 1;
    const prior = before.get(a.analysis)!;
    const next = JSON.stringify(a.findings);
    if (prior.leverRank === a.leverRank && JSON.stringify(prior.findings) === next) continue;
    await tx.query(
      `UPDATE geo_analyses SET lever_rank = $1, findings = $2::jsonb
        WHERE project_id = $3 AND analysis = $4 AND window_start = $5::date AND window_days = $6 AND scoring_version = $7`,
      [a.leverRank, next, projectId, a.analysis, windowStart, windowDays, SCORING_VERSION],
    );
  }
  incrementCounter("nominara_geo_levers_ranked_total", { promoted: String(promoted) });
  // Counts and the window only: no workspace name, no finding text.
  logger.log({ event: "geo_levers_ranked", project_id: projectId, window_days: windowDays, analyses: rows.length, promoted });
}

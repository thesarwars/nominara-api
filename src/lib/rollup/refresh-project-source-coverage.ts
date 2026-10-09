import type { ClientBase } from "pg";
import { sourceCoverage } from "../scoring/index.js";
import { SOURCE_INDEX_ENGINE_KEY, SOURCE_INDEX_WINDOW_DAYS } from "./refresh-project-task-counts.js";

// STORY-169 — `projects.source_coverage`, via the pure `sourceCoverage()`
// formula in `src/lib/scoring/source-coverage.ts`.
//
// `project_source_index`'s key is `(project_id, source_domain_id, engine_key,
// window_start, window_days)` — several windows can coexist per domain. The
// cross-engine, 30-day window is the product's canonical "current" reading
// (the same convention `metric_daily`'s `engine_key='all'` row and the
// 30-day delta windows use elsewhere on this table), and the MOST RECENT
// `window_start` for that pair is "current" — a recompute replaces rather
// than accumulates, so there is exactly one row per domain to read once the
// window is fixed.
//
// ⚠ REVIEW FIX — `SOURCE_INDEX_ENGINE_KEY`/`SOURCE_INDEX_WINDOW_DAYS` are
// IMPORTED, not redeclared. This file used to carry its own private copy of
// both, alongside `refresh-project-task-counts.ts`'s exported pair (which
// `TasksService.listActionItems` and the demo seed already import) — two
// literals naming the same "current" window that could silently drift apart
// and make `source_coverage` and an action item's severity read different
// windows for the same project.

// NEW-C-4 audit — a NULL `gap_severity` means presence on the domain is not yet
// verified. Dropping such rows would treat "not measured" as "no gap" and
// inflate the score (a domain holding 89% of the weight, unchecked, would
// read as covered). So the score is published ONLY when every domain in the
// window is verified; any unverified one makes it NULL ("not measured"),
// never a number computed over a verified subset.
// OWNER DECISION PENDING: the alternatives (a verified-weight threshold, or
// renormalising and labelling the result) need a spec constant or a contract
// field; this conservative rule invents neither and is encoded in
// test/integration/refresh-project-source-index.spec.ts.

/** Recompute one project's source coverage from `project_source_index`. */
export async function refreshProjectSourceCoverage(tx: ClientBase, projectId: string): Promise<void> {
  const latestWindow = await tx.query<{ window_start: string | null }>(
    `SELECT max(window_start)::text AS window_start
       FROM project_source_index
      WHERE project_id = $1 AND engine_key = $2 AND window_days = $3`,
    [projectId, SOURCE_INDEX_ENGINE_KEY, SOURCE_INDEX_WINDOW_DAYS],
  );
  const windowStart = latestWindow.rows[0]?.window_start ?? null;

  // No window computed at all — null, not the pure function's own empty-input
  // null, so the two "nothing to read" cases share exactly one code path.
  const domains =
    windowStart === null
      ? []
      : (
          await tx.query<{ context_weight: string; gap_severity: "none" | "low" | "medium" | "high" | "critical" | null }>(
            `SELECT context_weight::text, gap_severity
               FROM project_source_index
              WHERE project_id = $1 AND engine_key = $2 AND window_days = $3 AND window_start = $4::date`,
            [projectId, SOURCE_INDEX_ENGINE_KEY, SOURCE_INDEX_WINDOW_DAYS, windowStart],
          )
        ).rows;

  const fullyVerified = domains.every((row) => row.gap_severity !== null);
  const coverage = !fullyVerified ? null : sourceCoverage(domains.map((row) => ({ contextWeight: Number(row.context_weight), gapSeverity: row.gap_severity! })));

  await tx.query(`UPDATE projects SET source_coverage = $2 WHERE id = $1`, [projectId, coverage]);
}

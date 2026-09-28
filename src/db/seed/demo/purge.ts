import type { ClientBase } from "pg";
import { refreshProjectAux } from "../../../lib/rollup/refresh-project-aux.js";
import { refreshProjectSourceCoverage } from "../../../lib/rollup/refresh-project-source-coverage.js";
import { refreshProjectTaskCounts } from "../../../lib/rollup/refresh-project-task-counts.js";
import { deleteExistingDemoAudits } from "./aux.js";
import { DEMO_PROJECT_CREATED_KEY } from "./constants.js";
import { deleteExistingDemoFacts } from "./facts.js";
import { deleteExistingDemoSources } from "./sources.js";
import { deleteExistingDemoTasks } from "./tasks.js";

// STORY-169 — `--purge`: removes everything the seed created for a
// workspace, except the wallet and the ledger (append-only, never touched).
//
// ⚠ `denormalizeProject` CANNOT EXPRESS "there was a rollup and now there is
// none" — it returns early the moment `metric_daily` has zero rows for the
// project (see its own header comment), which is correct for "never
// rolled up" and leaves a PRIOR value in place for "was rolled up, and the
// facts are now gone". So this file NULLs the metric-derived `projects`
// columns directly, after deleting the metric_daily rows that fed them —
// the honest state for "no rollup has ever run", which is what purging a
// demo project's facts actually leaves it in. AUX/task/source producers do
// NOT have this problem — each already reports null/zero on an empty input
// (`refreshProjectAux`'s subquery, `refreshProjectTaskCounts`'s `count(*)`,
// `sourceCoverage()`'s empty-array null) — so those three are re-run for
// real rather than special-cased.

export interface PurgeableProject {
  readonly id: string;
  readonly workspaceId: string;
  readonly seedCreated: boolean;
}

/** Every project in the workspace this seed touched — `demo_seeded_at IS NOT NULL`. */
export async function listSeededProjects(tx: ClientBase, workspaceId: string): Promise<PurgeableProject[]> {
  const result = await tx.query<{ id: string; workspace_id: string; fingerprint: Record<string, unknown> }>(
    `SELECT id, workspace_id, fingerprint FROM projects WHERE workspace_id = $1 AND demo_seeded_at IS NOT NULL`,
    [workspaceId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    seedCreated: row.fingerprint?.[DEMO_PROJECT_CREATED_KEY] === true,
  }));
}

async function clearDenormalizedColumns(tx: ClientBase, projectId: string): Promise<void> {
  await tx.query(
    `UPDATE projects
        SET visibility_blended = NULL,
            visibility_delta_30d = NULL,
            visibility_by_engine = NULL,
            rendering_quality = NULL,
            rendering_delta_30d = NULL,
            sentiment_score = NULL,
            sentiment_delta_30d = NULL,
            cells_30d = NULL,
            sparkline_30d = NULL,
            demo_seeded_at = NULL
      WHERE id = $1`,
    [projectId],
  );
}

/** Purges one project's demo data. Deletes the project row outright when the seed created it; otherwise cleans it back to its pre-seed, never-rolled-up state. */
export async function purgeOneProject(tx: ClientBase, project: PurgeableProject): Promise<void> {
  // Facts + metric_daily first — nothing downstream depends on them.
  const earliest = await tx.query<{ min: string | null }>(
    `SELECT to_char(min(metric_date), 'YYYY-MM-DD') AS min FROM metric_daily WHERE project_id = $1`,
    [project.id],
  );
  const earliestDay = earliest.rows[0]?.min ?? "1970-01-01";
  await deleteExistingDemoFacts(tx, project.id, earliestDay);
  await tx.query(`DELETE FROM metric_daily WHERE project_id = $1`, [project.id]);
  await clearDenormalizedColumns(tx, project.id);

  await deleteExistingDemoAudits(tx, project.id);
  await refreshProjectAux(tx, project.id);

  await deleteExistingDemoTasks(tx, project.id);
  await refreshProjectTaskCounts(tx, project.id);

  await deleteExistingDemoSources(tx, project.workspaceId, project.id);
  await refreshProjectSourceCoverage(tx, project.id);

  if (project.seedCreated) {
    // Hard delete — `ON DELETE CASCADE` takes competitors, tracked_prompts,
    // project_engines, capture_runs and milestones with it. Everything with
    // no FK to `projects` (the fact tables, aux, sources, tasks) was already
    // removed above by project_id.
    await tx.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
}

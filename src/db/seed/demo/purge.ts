import type { ClientBase } from "pg";
import { PROMPT_OCCUPIES_SLOT } from "../../../lib/entitlements/structural-usage.js";
import { withProjectQueueLock } from "../../../lib/queue/locks.js";
import { datesWithFacts } from "../../../lib/rollup/aggregate-day.js";
import { denormalizeProject } from "../../../lib/rollup/denormalize.js";
import { refreshProjectAux } from "../../../lib/rollup/refresh-project-aux.js";
import { refreshProjectSourceCoverage } from "../../../lib/rollup/refresh-project-source-coverage.js";
import { refreshProjectTaskCounts } from "../../../lib/rollup/refresh-project-task-counts.js";
import { rollUpDay } from "../../../lib/rollup/roll-up-day.js";
import { deleteExistingDemoAudits } from "./aux.js";
import { DEMO_PROJECT_CREATED_KEY, DEMO_PROMPT_MARKER_KEY, DEMO_SEED_MARKER } from "./constants.js";
import { deleteExistingDemoFacts, structuralCap } from "./facts.js";
import { deleteExistingDemoSources } from "./sources.js";
import { deleteExistingDemoTasks } from "./tasks.js";

/** `projects.prompts_cap` is `smallint` — same duplicated constant as `facts.ts`'s own `ensurePrompts` and `activation.service.ts`'s `PROMPTS_CAP_COLUMN_MAX` (a one-line constant from an unrelated story's file, not worth a cross-module import). */
const PROMPTS_CAP_COLUMN_MAX = 32_767;

// STORY-169 — `--purge`: removes everything the seed created for a
// workspace, except the wallet and the ledger (append-only, never touched).
//
// ⚠ `denormalizeProject` CANNOT EXPRESS "there was a rollup and now there is
// none" — it returns early the moment `metric_daily` has zero rows for the
// project (see its own header comment), which is correct for "never
// rolled up" and leaves a PRIOR value in place for "was rolled up, and the
// facts are now gone". AUX/task/source producers do NOT have this problem —
// each already reports null/zero on an empty input (`refreshProjectAux`'s
// subquery, `refreshProjectTaskCounts`'s `count(*)`, `sourceCoverage()`'s
// empty-array null) — so those three are re-run for real rather than
// special-cased.
//
// ⚠ REVIEW FIX — `metric_daily` is RE-ROLLED, never blanket-deleted. The
// first version of this file ran `DELETE FROM metric_daily WHERE project_id
// = $1` unconditionally, which for a PRE-EXISTING (not seed-created) project
// destroyed real rollup history outside the seed's own window — a real
// project with one real `metric_daily` row from 90 days ago lost it on
// `--purge`, with nothing marking that row as anything but real. The fix:
// delete ONLY the demo-marked facts, `DELETE metric_daily` for exactly the
// date range that could have been touched (its own min `metric_date` through
// today), then `rollUpDay` every day inside that range that still has
// remaining (real) facts — `datesWithFacts`, the SAME function the real
// rebuild path uses. A day left with zero facts after the demo ones are
// gone correctly gets NO row, matching what the real pipeline would have
// produced for a day nobody ever captured. Only when the project's entire
// `metric_daily` history is empty afterward — genuinely "never rolled up" —
// are the denormalised columns NULLed directly.
//
// ⚠ KNOWN, UNDECIDED GAP — `tracked_prompts` rows this seed actually
// inserted (not reused from a pre-existing project) are marked via
// `generator_meta->>'demo_seed_marker'` and removed here. `competitors` has
// no comparable jsonb column, so a seeded competitor on a pre-existing
// project is NOT removed by `--purge` — `facts.ts`'s `ensureCompetitors` at
// least stops writing past the plan's cap now, but telling a seeded
// competitor apart from the project's own needs a schema decision this
// review does not make unilaterally.

export interface PurgeableProject {
  readonly id: string;
  readonly workspaceId: string;
  readonly seedCreated: boolean;
  /** NEW-A-8 — found only by its demo-marked captures (`--facts-only`): `demo_seeded_at` was never set, so only facts, the rollup and marked prompts are purged. */
  readonly factsOnly: boolean;
}

/**
 * Every project in the workspace this seed touched — `demo_seeded_at IS NOT
 * NULL` (a full seed), or any demo-marked capture (NEW-A-8 `--facts-only`,
 * which sets no `demo_seeded_at`). `projectId` narrows to one project.
 */
export async function listSeededProjects(tx: ClientBase, workspaceId: string, projectId?: string): Promise<PurgeableProject[]> {
  const result = await tx.query<{ id: string; workspace_id: string; fingerprint: Record<string, unknown>; seeded: boolean }>(
    `SELECT p.id, p.workspace_id, p.fingerprint, (p.demo_seeded_at IS NOT NULL) AS seeded
       FROM projects p
      WHERE p.workspace_id = $1
        AND ($3::uuid IS NULL OR p.id = $3::uuid)
        AND (p.demo_seeded_at IS NOT NULL
             OR EXISTS (SELECT 1 FROM answer_captures c WHERE c.project_id = p.id AND c.normalizer_version = $2))`,
    [workspaceId, DEMO_SEED_MARKER, projectId ?? null],
  );
  return result.rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    seedCreated: row.seeded && row.fingerprint?.[DEMO_PROJECT_CREATED_KEY] === true,
    factsOnly: !row.seeded,
  }));
}

/** Unconditional — the demo marker itself, regardless of whether any metric-derived column survives. */
async function clearDemoMarker(tx: ClientBase, projectId: string): Promise<void> {
  await tx.query(`UPDATE projects SET demo_seeded_at = NULL WHERE id = $1`, [projectId]);
}

/** Only correct when `metric_daily` truly has zero rows for the project afterward — see this file's own header comment on why `denormalizeProject` cannot express that state itself. */
async function clearMetricColumns(tx: ClientBase, projectId: string): Promise<void> {
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
            sparkline_30d = NULL
      WHERE id = $1`,
    [projectId],
  );
}

/**
 * Deletes this seed's own demo facts, then RE-ROLLS the affected date range
 * from whatever real facts remain — never a blanket `DELETE FROM
 * metric_daily`. A day with no remaining facts correctly ends up with no
 * `metric_daily` row at all, exactly like a day the real pipeline never
 * captured; a day with real facts still present is recomputed from them,
 * not deleted.
 *
 * ⚠ THE AFFECTED RANGE IS THE DEMO FACTS' OWN DATE SPAN, read from
 * `answer_captures` BEFORE they are deleted — never `metric_daily`'s own
 * `min(metric_date)`. The first version of this fix used the latter, which
 * is wrong the moment a pre-existing project has REAL rollup history: its
 * earliest REAL day becomes `min(metric_date)`, which then puts that real
 * day inside the "affected range" and deletes it right back out — the
 * exact defect this function exists to fix, reintroduced one query up.
 * Scoping to the demo facts' own min/max keeps the deleted-and-rerolled
 * window to exactly what the seed could have touched.
 */
async function purgeMetricHistory(tx: ClientBase, project: PurgeableProject, timezone: string): Promise<void> {
  const demoRange = await tx.query<{ min: string | null; max: string | null }>(
    `SELECT to_char(min((captured_at AT TIME ZONE $2)::date), 'YYYY-MM-DD') AS min,
            to_char(max((captured_at AT TIME ZONE $2)::date), 'YYYY-MM-DD') AS max
       FROM answer_captures
      WHERE project_id = $1 AND normalizer_version = $3`,
    [project.id, timezone, DEMO_SEED_MARKER],
  );
  const earliestDay = demoRange.rows[0]?.min;
  const latestDay = demoRange.rows[0]?.max;
  if (earliestDay === null || earliestDay === undefined || latestDay === null || latestDay === undefined) {
    // No demo facts ever existed for this project (e.g. a re-run of
    // `--purge`, or a project with no entitled engine) — nothing to
    // re-roll, and whatever `metric_daily` already holds is already honest.
    return;
  }

  await deleteExistingDemoFacts(tx, project.id, earliestDay, timezone);

  await withProjectQueueLock(tx, "rollup.metric_daily", project.id, async () => {
    await tx.query(`DELETE FROM metric_daily WHERE project_id = $1 AND metric_date BETWEEN $2::date AND $3::date`, [
      project.id,
      earliestDay,
      latestDay,
    ]);
    const remainingDays = await datesWithFacts(tx, project.id, timezone, earliestDay, latestDay);
    for (const day of remainingDays) {
      await rollUpDay(tx, project.workspaceId, project.id, day, timezone);
    }
    await denormalizeProject(tx, project.id, timezone);
  });

  const remaining = await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM metric_daily WHERE project_id = $1`, [
    project.id,
  ]);
  if (Number(remaining.rows[0]!.n) === 0) {
    // `denormalizeProject` returned early above (its own documented
    // behaviour on zero rows) and left the PRIOR values in place — the
    // "never rolled up" state has to be written explicitly.
    await clearMetricColumns(tx, project.id);
  }
}

/**
 * Removes exactly the `tracked_prompts` rows this seed INSERTED for the
 * project (never one it only reused because a pre-existing prompt already
 * had the same `text_hash` — `facts.ts`'s `ensurePrompts` marks only its own
 * inserts), then recomputes BOTH `prompts_active` AND `prompts_cap` the same
 * way `activation.service.ts` does — never left stale after a status-
 * changing write to `tracked_prompts`.
 *
 * ⚠ REVIEW FIX — `prompts_cap` used to be left at whatever `ensurePrompts`
 * wrote during the seed run, not restored. It needs no pre-seed snapshot to
 * fix: `structuralCap` (`facts.ts`) resolves it straight from the
 * workspace's CURRENT entitlement, exactly as `activation.service.ts`'s own
 * `resolveCap` does — the column is a cache of that resolution, never its
 * own source of truth, so recomputing it here is always correct, the same
 * way `prompts_active` already was.
 */
async function purgeDemoPrompts(tx: ClientBase, project: PurgeableProject): Promise<void> {
  await tx.query(`DELETE FROM tracked_prompts WHERE project_id = $1 AND generator_meta ->> $2 = $3`, [
    project.id,
    DEMO_PROMPT_MARKER_KEY,
    DEMO_SEED_MARKER,
  ]);
  const cap = await structuralCap(tx, project.workspaceId, "prompts.max_per_project");
  await tx.query(
    `UPDATE projects
        SET prompts_active = (SELECT count(*) FROM tracked_prompts WHERE project_id = $1 AND ${PROMPT_OCCUPIES_SLOT}),
            prompts_cap = $2
      WHERE id = $1`,
    [project.id, Math.min(cap, PROMPTS_CAP_COLUMN_MAX)],
  );
}

/** Purges one project's demo data. Deletes the project row outright when the seed created it; otherwise cleans it back to its pre-seed state. */
export async function purgeOneProject(tx: ClientBase, project: PurgeableProject, timezone: string): Promise<void> {
  // Facts + metric_daily first — nothing downstream depends on them.
  await purgeMetricHistory(tx, project, timezone);
  if (project.factsOnly) {
    // NEW-A-8 — a `--facts-only` project never had AUX, sources, tasks or a
    // demo marker written, and its sources/aux/tasks (if any) are REAL: the
    // full-seed deletes below remove by project_id with no marker for
    // sources, so they must not run here.
    await purgeDemoPrompts(tx, project);
    return;
  }
  await clearDemoMarker(tx, project.id);

  await deleteExistingDemoAudits(tx, project.id);
  await refreshProjectAux(tx, project.id);

  await deleteExistingDemoTasks(tx, project.id);
  await refreshProjectTaskCounts(tx, project.id);

  await deleteExistingDemoSources(tx, project.workspaceId, project.id);
  await refreshProjectSourceCoverage(tx, project.id);

  await purgeDemoPrompts(tx, project);
  // competitors — SEE THIS FILE'S OWN HEADER: no marker column exists yet,
  // so a seeded competitor on a pre-existing project is not removed here.

  if (project.seedCreated) {
    // Hard delete — `ON DELETE CASCADE` takes competitors, tracked_prompts,
    // project_engines, capture_runs and milestones with it. Everything with
    // no FK to `projects` (the fact tables, aux, sources, tasks) was already
    // removed above by project_id.
    await tx.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  }
}

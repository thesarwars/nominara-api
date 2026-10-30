import type { ClientBase } from "pg";

// STORY-169 — `projects.open_task_count` and `projects.open_tasks_by_severity`.
//
// A SEPARATE producer from `denormalizeProject`, deliberately: that function
// only ever reads `metric_daily`, and `tasks` has no producer of its own yet
// (STORY-063/064). This is what the dev-only demo seed calls today, and what
// `task.generate`'s real handler and any task-mutation endpoint will call
// once they exist — the SAME function, so "how many tasks are open" is
// computed in exactly one place.
//
// Severity has no column on `tasks` (`priority` is a 1-5 ranking, not a
// severity). The only two derivations the spec gives are named directly on
// `tasks`: `aux_findings.severity` via `source_finding_id`, and
// `project_source_index.gap_severity` via `source_domain_id` — in that
// order, the finding taking precedence when both happen to be set. A task
// deriving neither counts only in the total, never in a severity bucket —
// `open_tasks_by_severity`'s keys are exactly `critical`/`high`/`medium`/`low`,
// and `gap_severity` can also be `'none'`, which matches none of them and so
// correctly falls through to "total only" without special-casing it here.

/**
 * `project_source_index`'s key is `(project_id, source_domain_id, engine_key,
 * window_start, window_days)` — several rows can exist for one domain. The
 * cross-engine, 30-day row is the SAME window `refreshProjectSourceCoverage`
 * reads, and the most recently computed one of those is used here for the
 * same reason: one canonical "current" reading per domain, not a window
 * chosen per task.
 */
// Exported for `TasksService.listActionItems` (STORY-169 API step 2/3),
// which needs the SAME "current" reading per domain to derive severity for
// the cross-project action queue — one canonical choice of window, in one
// place, rather than a second literal that could drift from this one.
export const SOURCE_INDEX_ENGINE_KEY = "all";
export const SOURCE_INDEX_WINDOW_DAYS = 30;

export interface TaskSeverityCounts {
  readonly critical: number;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
}

/**
 * Recompute one project's open-task count and severity breakdown from `tasks`.
 *
 * ⚠ REVIEW FIX — locks the project row FIRST. This function's own header
 * names `task.generate` and every future task-mutation endpoint as callers,
 * plural — with no lock, two concurrent callers each SELECT the count
 * before either UPDATEs, so the second caller's UPDATE (which blocks on the
 * row, then overwrites) can land a COUNT taken before the first caller's
 * task existed, silently losing that task from the denormalised total.
 * `SELECT ... FOR NO KEY UPDATE` serialises the two calls instead: the
 * second caller's count only starts once the first has committed its
 * UPDATE, so it counts the first caller's write too. Latent today because
 * only the seed calls this; real once a mutation endpoint does.
 *
 * ⚠ REVIEW FIX 2 — `FOR NO KEY UPDATE`, NOT `FOR UPDATE`. `tasks.project_id`
 * references `projects(id)`, so every `INSERT INTO tasks` takes a `FOR KEY
 * SHARE` lock on the project row for the duration of its transaction. `FOR
 * UPDATE` conflicts with `FOR KEY SHARE`: two writers that each insert a
 * task and then call this function can deadlock — writer A holds `FOR KEY
 * SHARE` (from its insert) and waits on writer B's `FOR KEY SHARE` to
 * upgrade to `FOR UPDATE`, while writer B is waiting on A's for the same
 * reason. Postgres detects the cycle and aborts one side with `40P01`,
 * rolling back that writer's task insert along with the count it came here
 * to record — the exact "task.generate" concurrent-writer shape this
 * function's own header names. `FOR NO KEY UPDATE` only conflicts with
 * `FOR UPDATE`/`FOR NO KEY UPDATE`, never with `FOR KEY SHARE`, so it still
 * serialises two concurrent refreshers against each other (the lost-update
 * fix above) without conflicting with a FK-driven `INSERT`. Nothing here
 * changes the project row through THIS statement — no column that a `FOR
 * KEY SHARE` locker (a referencing INSERT) could be racing to protect — so
 * the weaker lock loses no correctness.
 */
// OPEN = `todo`, `in_progress` or `in_review` (owner decision 30, STORY-055): a seeding task whose contribution URL awaits
// verification is unfinished work and the gap it targets is still open, so submitting a URL must not drop the count (and a failed
// check must not raise it again). `done` and `dismissed` leave the count.
export async function refreshProjectTaskCounts(tx: ClientBase, projectId: string): Promise<void> {
  await tx.query(`SELECT id FROM projects WHERE id = $1 FOR NO KEY UPDATE`, [projectId]);
  const result = await tx.query<{ critical: string; high: string; medium: string; low: string; total: string }>(
    `WITH open_tasks AS (
       SELECT t.id,
              COALESCE(af.severity, psi.gap_severity) AS severity
         FROM tasks t
         LEFT JOIN aux_findings af ON af.id = t.source_finding_id
         LEFT JOIN LATERAL (
           SELECT gap_severity
             FROM project_source_index
            WHERE source_domain_id = t.source_domain_id
              AND project_id = t.project_id
              AND engine_key = $2
              AND window_days = $3
            ORDER BY window_start DESC
            LIMIT 1
         ) psi ON t.source_domain_id IS NOT NULL
        WHERE t.project_id = $1
          AND t.status IN ('todo', 'in_progress', 'in_review')
          AND t.deleted_at IS NULL
     )
     SELECT count(*) FILTER (WHERE severity = 'critical')::text AS critical,
            count(*) FILTER (WHERE severity = 'high')::text     AS high,
            count(*) FILTER (WHERE severity = 'medium')::text   AS medium,
            count(*) FILTER (WHERE severity = 'low')::text      AS low,
            count(*)::text                                      AS total
       FROM open_tasks`,
    [projectId, SOURCE_INDEX_ENGINE_KEY, SOURCE_INDEX_WINDOW_DAYS],
  );

  const row = result.rows[0]!;
  await tx.query(
    `UPDATE projects
        SET open_task_count = $2,
            open_tasks_by_severity = $3::jsonb
      WHERE id = $1`,
    [
      projectId,
      Number(row.total),
      JSON.stringify({
        critical: Number(row.critical),
        high: Number(row.high),
        medium: Number(row.medium),
        low: Number(row.low),
      } satisfies TaskSeverityCounts),
    ],
  );
}

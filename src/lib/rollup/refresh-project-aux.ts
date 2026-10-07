import type { ClientBase } from "pg";

// STORY-169 — `projects.aux_score_current`.
//
// This does NOT compute an AUX score — `src/lib/scoring/aux.ts` does that.
// It denormalises the score a completed audit already produced, the same
// relationship `denormalizeProject` has to `metric_daily`: one indexed scan
// over `projects` reads a figure a separate pipeline already committed.
//
// "Latest" is the most recently FINISHED completed audit, not the most
// recently CREATED one — a `queued`/`running` audit newer than the last
// completed one must not blank out the current score while it works.

/** Denormalise the latest completed audit's score onto the project row. */
export async function refreshProjectAux(tx: ClientBase, projectId: string): Promise<void> {
  await tx.query(
    `UPDATE projects
        SET aux_score_current = (
          SELECT aux_score
            FROM aux_audits
           WHERE project_id = $1
             AND status = 'completed'
           ORDER BY finished_at DESC NULLS LAST, created_at DESC
           LIMIT 1
        )
      WHERE id = $1`,
    [projectId],
  );
}

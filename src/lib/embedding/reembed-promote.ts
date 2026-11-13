import type { ClientBase } from "pg";
import { lockNodeScope } from "../geo/alignment/scope-lock.js";

// STORY-186 (owner decision 104(c)) - the per-project cutover of a re-embed.
//
// A re-embed STAGES the new vectors (`embedding_next`, written by an `embed.batch` stage job) and leaves the served pair
// (`embedding`, `embedding_model`) alone. This is the one step that switches a project: when EVERY live prompt and node of the project
// holds a staged vector under the target model, one UPDATE per table moves it across, in this transaction. Until then the project is
// wholly on the old model, so no similarity query ever sees a half-switched project (STORY-047: a gradual release loses cluster renames).
//
// NO I/O: SQL only, in the caller's tenant transaction (ADR-0003). Every statement carries `workspace_id = app.current_workspace()`.
//
// IDEMPOTENT AND RESUMABLE. A promote that finds nothing staged for the model changes nothing; one interrupted before COMMIT rolled
// back whole, so a rerun starts from the same state. A project that is not complete is left exactly as it was and says why.

export type PromoteOutcome =
  | { readonly status: "promoted"; readonly prompts: number; readonly nodes: number }
  | { readonly status: "nothing_staged" }
  /** `incomplete`: a prompt or node still lacks its staged vector. `open_session`: an alignment session pinned to another model is open. */
  | { readonly status: "blocked"; readonly reason: "incomplete" | "open_session" };

/** Live rows that have a vector under another model and no staged vector for `$2` yet (the rows a stage job still owes). */
const INCOMPLETE_SQL = `
  SELECT (SELECT count(*) FROM tracked_prompts
           WHERE project_id = $1 AND workspace_id = app.current_workspace() AND deleted_at IS NULL
             AND embedding IS NOT NULL AND embedding_model IS DISTINCT FROM $2
             AND (embedding_next IS NULL OR embedding_next_model IS DISTINCT FROM $2))
       + (SELECT count(*) FROM semantic_nodes
           WHERE project_id = $1 AND workspace_id = app.current_workspace()
             AND embedding IS NOT NULL AND embedding_model IS DISTINCT FROM $2
             AND (embedding_next IS NULL OR embedding_next_model IS DISTINCT FROM $2)) AS n`;

export async function promoteProject(tx: ClientBase, projectId: string, model: string): Promise<PromoteOutcome> {
  // Node scopes first, in one fixed order (the lock key's hash), as embed-batch's semantic_nodes commit does: an analysis holds a scope's
  // lock while it bulk-updates that scope's nodes, and the UPDATE below touches the same rows.
  const scopes = await tx.query<{ prompt_cluster_id: string | null }>(
    `SELECT prompt_cluster_id FROM (
       SELECT DISTINCT prompt_cluster_id FROM semantic_nodes WHERE project_id = $1 AND workspace_id = app.current_workspace()
     ) s
      ORDER BY hashtextextended($1::text || ':' || COALESCE(prompt_cluster_id::text, ''), 0), prompt_cluster_id NULLS LAST`,
    [projectId],
  );
  for (const scope of scopes.rows) await lockNodeScope(tx, projectId, scope.prompt_cluster_id);

  const incomplete = await tx.query<{ n: string }>(INCOMPLETE_SQL, [projectId, model]);
  if (Number(incomplete.rows[0]!.n) > 0) return { status: "blocked", reason: "incomplete" };

  const staged = await tx.query<{ n: string }>(
    `SELECT (SELECT count(*) FROM tracked_prompts WHERE project_id = $1 AND workspace_id = app.current_workspace() AND embedding_next_model = $2)
          + (SELECT count(*) FROM semantic_nodes WHERE project_id = $1 AND workspace_id = app.current_workspace() AND embedding_next_model = $2) AS n`,
    [projectId, model],
  );
  if (Number(staged.rows[0]!.n) === 0) return { status: "nothing_staged" };

  // CONSERVATIVE (PROVISIONAL): an alignment session is pinned to the model its nodes were embedded under and reads only nodes of that
  // model. Promoting under an OPEN one would leave it with no nodes, so the project waits until the session is patched or discarded.
  const open = await tx.query(
    `SELECT 1 FROM geo_alignments
      WHERE project_id = $1 AND workspace_id = app.current_workspace() AND status = 'open' AND embedding_model IS DISTINCT FROM $2
      LIMIT 1`,
    [projectId, model],
  );
  if ((open.rowCount ?? 0) > 0) return { status: "blocked", reason: "open_session" };

  const prompts = await tx.query(
    `UPDATE tracked_prompts
        SET embedding = embedding_next, embedding_model = embedding_next_model, embedding_next = NULL, embedding_next_model = NULL
      WHERE project_id = $1 AND workspace_id = app.current_workspace() AND embedding_next_model = $2`,
    [projectId, model],
  );
  const nodes = await tx.query(
    `UPDATE semantic_nodes
        SET embedding = embedding_next, embedding_model = embedding_next_model, embedding_next = NULL, embedding_next_model = NULL
      WHERE project_id = $1 AND workspace_id = app.current_workspace() AND embedding_next_model = $2`,
    [projectId, model],
  );
  return { status: "promoted", prompts: prompts.rowCount ?? 0, nodes: nodes.rowCount ?? 0 };
}

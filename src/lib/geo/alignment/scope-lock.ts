import type { ClientBase } from "pg";

// STORY-059 - serialise the writers of one (project, cluster) scope.
//
// `semantic_nodes` rows are shared by every session of a scope, and an extraction deletes then re-inserts the whole scope. Under READ
// COMMITTED a second writer cannot see the first's uncommitted rows, so two extractions race on `ux_semantic_nodes` (23505, or with a
// NULL cluster, where the key treats NULLs as distinct, duplicate nodes), and two analyses interleave their dedupe DELETEs and can
// deadlock. A transaction-scoped advisory lock on the scope makes the second writer wait for the first to commit, then see its rows.
// It is released at commit or rollback; there is no session-level lock to leak (`pg_advisory_xact_lock`, never `pg_advisory_lock`).
export async function lockNodeScope(tx: ClientBase, projectId: string, clusterId: string | null): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || COALESCE($2::text, ''), 0))", [projectId, clusterId]);
}

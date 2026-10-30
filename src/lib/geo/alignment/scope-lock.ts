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

// A READER that needs the judged check and the nodes to agree (STORY-057's concept gap reads two statements, each with its own READ COMMITTED
// snapshot) takes the SHARED form of the same key: it waits out an in-flight extraction or analysis (their exclusive lock conflicts) and then
// blocks a new one until its transaction ends. Several readers do not block each other.
export async function lockNodeScopeShared(tx: ClientBase, projectId: string, clusterId: string | null): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text || ':' || COALESCE($2::text, ''), 0))", [projectId, clusterId]);
}

// Several scopes at once (STORY-057's rollup reads every cluster of a project): the locks are taken in ONE fixed order, the hash of the lock key
// then (project, cluster NULLS LAST), the order embed-batch's semantic_nodes commit takes its exclusive locks in. Two transactions spanning several
// scopes therefore cannot lock against each other. Callers take them once, up front, never scope by scope as the reads arrive.
export async function lockNodeScopesShared(tx: ClientBase, projectId: string, clusterIds: readonly (string | null)[]): Promise<void> {
  if (clusterIds.length === 0) return;
  const ordered = await tx.query<{ cluster_id: string | null }>(
    `SELECT cluster_id FROM (SELECT DISTINCT c AS cluster_id FROM unnest($2::uuid[]) AS c) s
      ORDER BY hashtextextended($1::text || ':' || COALESCE(cluster_id::text, ''), 0), cluster_id NULLS LAST`,
    [projectId, [...clusterIds]],
  );
  for (const scope of ordered.rows) await lockNodeScopeShared(tx, projectId, scope.cluster_id);
}

import type { ClientBase } from "pg";
import { CLUSTER_SIMILARITY_FLOOR, FUNNEL_WEIGHT_SQL, LABEL_SAMPLE_SIZE, MAX_CLUSTERS_PER_PROJECT, MIN_CLUSTER_SIZE } from "./constants.js";
import type { OldCluster } from "./matching.js";

// STORY-047 - the clustering itself. EVERY VECTOR OPERATION IS A SQL STATEMENT (AC10): similarity is pgvector's `<=>`, a centroid is
// `avg(embedding)`, and no statement here returns an embedding or a centroid to the application. What crosses into JavaScript is
// ids, texts and counts. The loops below iterate over GROUPS (one statement per cluster found), never over vector components.
//
// THE ALGORITHM, and why it is not HDBSCAN. aux-and-geo-analysis.md names HDBSCAN for the prompt clusters; HDBSCAN needs a
// minimum spanning tree over the whole set and cannot be expressed as pgvector SQL, and AC10 forbids doing it in application code.
// What the story and the schema pin is the outcome: groups at cosine >= 0.82, a centroid and a count, outliers left out. This is
// seeded greedy grouping: take the prompt with the most still-free neighbours at or above the floor, make it and those neighbours a
// cluster, remove them, repeat while the best seed still has MIN_CLUSTER_SIZE. Every member is therefore within the floor of its
// SEED (a coherent cluster, no chaining), and a prompt at no seed's floor is never forced in. Deterministic: ties break on id.
// BUILDER READING, flagged in the STORY-047 report.

/**
 * What makes a prompt clusterable. Shared by the grouping, the hash and the sweep so the three can never disagree about "the prompt
 * set". No `workspace_id` predicate: RLS scopes the tenant (the sweep runs as the owner and groups by project).
 */
export function clusterableBaseSql(alias: string): string {
  return `${alias}.deleted_at IS NULL AND ${alias}.status = 'active' AND ${alias}.superseded_by IS NULL AND ${alias}.embedding IS NOT NULL AND ${alias}.embedding_model IS NOT NULL`;
}
export const CLUSTERABLE_BASE_SQL = clusterableBaseSql("p");

/** sha256 over the model and the sorted ids of the clusterable set. `$model` and the id list are SQL fragments the caller supplies. */
export function promptSetHashSql(modelExpr: string, idsExpr: string): string {
  return `encode(sha256(convert_to(coalesce(${modelExpr}, '') || '|' || coalesce(${idsExpr}, ''), 'UTF8')), 'hex')`;
}

/**
 * `eff(pid, cid)`: for a prompt with no cluster of its own that REPLACES one (a reword), the cluster its predecessor was in, followed
 * along the `superseded_by` chain so a reword of a reword resolves too. `UNION` (not `ALL`) ends a cycle. Bind the project as `$1`.
 */
const EFFECTIVE_CLUSTER_CTE = `RECURSIVE chain(pid, cid) AS (
       SELECT q.superseded_by, q.cluster_id FROM tracked_prompts q
        WHERE q.project_id = $1 AND q.superseded_by IS NOT NULL AND q.cluster_id IS NOT NULL
       UNION
       SELECT n.superseded_by, ch.cid FROM chain ch JOIN tracked_prompts n ON n.id = ch.pid
        WHERE n.project_id = $1 AND n.superseded_by IS NOT NULL AND n.cluster_id IS NULL
     ), eff AS (SELECT DISTINCT ON (pid) pid, cid FROM chain ORDER BY pid, cid)`;

export interface PromptGroup {
  readonly index: number;
  readonly memberIds: readonly string[];
  /** Member texts nearest the group's centre first. Customer text. */
  readonly samples: readonly string[];
  readonly overlaps: ReadonlyMap<string, number>;
}

export interface ClusterSnapshot {
  readonly model: string | undefined;
  readonly promptSetHash: string;
  readonly clusterStateHash: string;
  readonly clusterable: number;
  readonly groups: readonly PromptGroup[];
  readonly olds: readonly (OldCluster & { readonly label: string })[];
}

/** The dominant embedding model among the project's clusterable prompts. Two models' vectors are never compared (EC-23). */
async function dominantModel(tx: ClientBase, projectId: string): Promise<string | undefined> {
  const r = await tx.query<{ embedding_model: string }>(
    `SELECT p.embedding_model FROM tracked_prompts p
      WHERE p.project_id = $1 AND ${CLUSTERABLE_BASE_SQL}
      GROUP BY p.embedding_model ORDER BY count(*) DESC, p.embedding_model LIMIT 1`,
    [projectId],
  );
  return r.rows[0]?.embedding_model;
}

export async function promptSetHash(tx: ClientBase, projectId: string, model: string | undefined): Promise<{ hash: string; clusterable: number }> {
  const r = await tx.query<{ hash: string; n: string }>(
    `SELECT ${promptSetHashSql("$2::text", "string_agg(p.id::text, ',' ORDER BY p.id)")} AS hash, count(*)::text AS n
       FROM tracked_prompts p
      WHERE p.project_id = $1 AND ${CLUSTERABLE_BASE_SQL} AND p.embedding_model = $2::text`,
    [projectId, model ?? ""],
  );
  return { hash: r.rows[0]!.hash, clusterable: Number(r.rows[0]!.n) };
}

/** Which clusters exist and which prompt points at which: a concurrent run that finished first changes it. */
export async function clusterStateHash(tx: ClientBase, projectId: string): Promise<string> {
  const r = await tx.query<{ hash: string }>(
    `SELECT encode(sha256(convert_to(
              coalesce((SELECT string_agg(id::text, ',' ORDER BY id) FROM topic_clusters WHERE project_id = $1), '') || '|' ||
              coalesce((SELECT string_agg(id::text || '>' || cluster_id::text, ',' ORDER BY id) FROM tracked_prompts WHERE project_id = $1 AND cluster_id IS NOT NULL), ''),
            'UTF8')), 'hex') AS hash`,
    [projectId],
  );
  return r.rows[0]!.hash;
}

/** Read-only. Finds the groups; writes nothing. */
export async function snapshotClusters(tx: ClientBase, projectId: string): Promise<ClusterSnapshot> {
  const model = await dominantModel(tx, projectId);
  const { hash, clusterable } = await promptSetHash(tx, projectId, model);
  const state = await clusterStateHash(tx, projectId);

  // An old cluster's size is the members that COULD be grouped now, under the same model the groups use. A paused row, a prompt of
  // another model, or the archived original an edit leaves behind (it keeps its cluster_id; the replacement starts unassigned) is
  // in no group and must not count against the match, or an ordinary reword would dissolve a cluster and delete the user's label
  // with it (AC3). A replacement counts as the cluster its predecessor was in (EFFECTIVE_CLUSTER_CTE), so rewording EVERY member
  // leaves the cluster whole as well.
  const olds = await tx.query<{ id: string; label: string; label_source: "auto" | "user"; n: string }>(
    `WITH ${EFFECTIVE_CLUSTER_CTE}
     SELECT c.id, c.label, c.label_source,
            (SELECT count(*) FROM tracked_prompts p LEFT JOIN eff ON eff.pid = p.id
              WHERE coalesce(p.cluster_id, eff.cid) = c.id AND ${CLUSTERABLE_BASE_SQL} AND p.embedding_model = $2::text)::text AS n
       FROM topic_clusters c WHERE c.project_id = $1 ORDER BY c.id`,
    [projectId, model ?? ""],
  );

  const raw: { memberIds: string[] }[] = [];
  if (model !== undefined) {
    const taken: string[] = [];
    while (raw.length < MAX_CLUSTERS_PER_PROJECT) {
      // The best seed among the still-free prompts: the one with the most free neighbours at or above the floor (itself included).
      const best = await tx.query<{ members: string[] }>(
        `SELECT array_agg(b.id ORDER BY b.id) AS members
           FROM tracked_prompts a
           JOIN tracked_prompts b ON b.project_id = a.project_id AND 1 - (a.embedding <=> b.embedding) >= $4::float8
          WHERE a.project_id = $1 AND ${clusterableBaseSql("a")} AND a.embedding_model = $2 AND NOT (a.id = ANY($3::uuid[]))
            AND ${clusterableBaseSql("b")} AND b.embedding_model = $2 AND NOT (b.id = ANY($3::uuid[]))
          GROUP BY a.id
         HAVING count(*) >= $5
          ORDER BY count(*) DESC, a.id
          LIMIT 1`,
        [projectId, model, taken, CLUSTER_SIMILARITY_FLOOR, MIN_CLUSTER_SIZE],
      );
      const members = best.rows[0]?.members;
      if (members === undefined) break;
      raw.push({ memberIds: members });
      taken.push(...members);
    }
  }

  const groups: PromptGroup[] = [];
  for (const [index, group] of raw.entries()) {
    const samples = await tx.query<{ text: string }>(
      `SELECT p.text
         FROM tracked_prompts p, (SELECT avg(q.embedding) AS centre FROM tracked_prompts q WHERE q.id = ANY($1::uuid[])) g
        WHERE p.id = ANY($1::uuid[])
        ORDER BY p.embedding <=> g.centre, p.id
        LIMIT $2`,
      [group.memberIds, LABEL_SAMPLE_SIZE],
    );
    const overlap = await tx.query<{ cluster_id: string; n: string }>(
      `WITH ${EFFECTIVE_CLUSTER_CTE}
       SELECT coalesce(p.cluster_id, eff.cid) AS cluster_id, count(*)::text AS n
         FROM tracked_prompts p LEFT JOIN eff ON eff.pid = p.id
        WHERE p.id = ANY($2::uuid[]) AND coalesce(p.cluster_id, eff.cid) IS NOT NULL GROUP BY 1`,
      [projectId, group.memberIds],
    );
    groups.push({
      index,
      memberIds: group.memberIds,
      samples: samples.rows.map((row) => row.text),
      overlaps: new Map(overlap.rows.map((row) => [row.cluster_id, Number(row.n)])),
    });
  }

  return {
    model,
    promptSetHash: hash,
    clusterStateHash: state,
    clusterable,
    groups,
    olds: olds.rows.map((row) => ({ id: row.id, label: row.label, labelSource: row.label_source, memberCount: Number(row.n) })),
  };
}

export interface ClusterPlanEntry {
  readonly clusterId: string;
  readonly memberIds: readonly string[];
  /** Present for a NEW cluster only; a matched cluster keeps the label it has (which may be a user's). */
  readonly newLabel?: string;
}

/**
 * Writes the plan. The caller holds the project lock and an open transaction, so the cluster rows and the membership commit
 * together (AC7): nothing here can leave a prompt pointing at a cluster that does not exist.
 *
 * `computed_at` is NOT written: it stamps the denormalised PERFORMANCE columns (schemas/projects-and-prompts.md) and belongs to the
 * rollup. The performance columns are left exactly as they are on a matched cluster.
 */
export async function writeClusters(
  tx: ClientBase,
  workspaceId: string,
  projectId: string,
  model: string | undefined,
  plan: readonly ClusterPlanEntry[],
): Promise<{ assigned: number; created: number; deleted: number }> {
  const fresh = plan.filter((entry) => entry.newLabel !== undefined);
  // Dissolved clusters go FIRST. `ux_topic_clusters` is checked per statement, so a new cluster whose label equals a dissolving
  // cluster's (a template label is deterministic; a model can repeat itself) would otherwise be refused while the old row is still
  // there, and every retry would rebuild the same plan and fail the same way. `tracked_prompts.cluster_id` has no FK and the
  // membership is rewritten below in this same transaction, so AC7 holds whatever the order.
  const deleted = await tx.query(`DELETE FROM topic_clusters WHERE project_id = $1 AND NOT (id = ANY($2::uuid[]))`, [
    projectId,
    plan.map((entry) => entry.clusterId),
  ]);
  if (fresh.length > 0) {
    await tx.query(
      `INSERT INTO topic_clusters (id, workspace_id, project_id, label, label_source, embedding_model)
       SELECT v.id, $2, $3, v.label, 'auto', $4 FROM unnest($1::uuid[], $5::text[]) AS v(id, label)`,
      [fresh.map((e) => e.clusterId), workspaceId, projectId, model ?? null, fresh.map((e) => e.newLabel!)],
    );
  }

  const memberIds = plan.flatMap((entry) => [...entry.memberIds]);
  const clusterOfMember = plan.flatMap((entry) => entry.memberIds.map(() => entry.clusterId));

  // Everything in the project that held a cluster and is not a member now (an outlier, a paused, deleted or re-embedded prompt) is let
  // go. A listed member that stopped being clusterable after the plan was made (the API's prompt writes do not take the project lock)
  // is let go too, and the assignment below skips it: it can never be given a cluster, or counted in one, past the plan.
  await tx.query(
    `UPDATE tracked_prompts p SET cluster_id = NULL
      WHERE p.project_id = $1 AND p.cluster_id IS NOT NULL
        AND (NOT (p.id = ANY($2::uuid[])) OR NOT (${CLUSTERABLE_BASE_SQL} AND p.embedding_model IS NOT DISTINCT FROM $3::text))`,
    [projectId, memberIds, model ?? null],
  );
  const assigned = await tx.query(
    `UPDATE tracked_prompts p SET cluster_id = v.cid
       FROM unnest($1::uuid[], $2::uuid[]) AS v(pid, cid)
      WHERE p.id = v.pid AND p.project_id = $3 AND p.cluster_id IS DISTINCT FROM v.cid
        AND ${CLUSTERABLE_BASE_SQL} AND p.embedding_model IS NOT DISTINCT FROM $4::text`,
    [memberIds, clusterOfMember, projectId, model ?? null],
  );
  // A planned cluster whose members all stopped being clusterable since the plan (or all but one) is no cluster: it would keep a
  // default count and a NULL centroid, or a stale count and centroid. Remove it and let go of any lone member.
  await tx.query(
    `WITH thin AS (
       SELECT c.id FROM topic_clusters c
        WHERE c.project_id = $1 AND (SELECT count(*) FROM tracked_prompts p WHERE p.cluster_id = c.id) < $2::int
     ), freed AS (
       UPDATE tracked_prompts SET cluster_id = NULL WHERE cluster_id IN (SELECT id FROM thin) RETURNING 1
     )
     DELETE FROM topic_clusters WHERE id IN (SELECT id FROM thin)`,
    [projectId, MIN_CLUSTER_SIZE],
  );
  // Centroid, count and commercial intent come from the rows now assigned, in one statement: a mean of the members' vectors and of
  // their funnel weights. Touches every kept cluster, so `min(updated_at)` is the time of the last clustering (see the sweep).
  await tx.query(
    `UPDATE topic_clusters c
        SET centroid = s.mean_vector, prompt_count = s.n, commercial_intent = s.intent, embedding_model = $2
       FROM (SELECT cluster_id, avg(embedding) AS mean_vector, count(*)::smallint AS n, avg(${FUNNEL_WEIGHT_SQL})::real AS intent
               FROM tracked_prompts WHERE project_id = $1 AND cluster_id IS NOT NULL GROUP BY cluster_id) s
      WHERE c.id = s.cluster_id AND c.project_id = $1`,
    [projectId, model ?? null],
  );
  return { assigned: assigned.rowCount ?? 0, created: fresh.length, deleted: deleted.rowCount ?? 0 };
}

import type { ClientBase } from "pg";
import { isLowConfidence } from "./weights.js";

// STORY-058 AC9 / AC10 / AC11 - step 8: the retrieval centroid, as ONE SQL statement.
//
//   c = normalize( sum_p centroid_weight(p) * embedding(p)  /  sum_p centroid_weight(p) )
//
// The vectors never leave Postgres: no embedding is read into the application, and there is no numeric loop over one (the lint rule
// that exists for this). The weighted sum is `sum(embedding * weight_vector)` - pgvector has no vector-by-scalar operator, so the
// weight is expanded to a constant vector (array_fill) and the elementwise product is summed. The division by sum(weight) is a scalar
// and `l2_normalize` is scale-invariant, so it is omitted rather than computed twice; the stored vector is the same one.
//
// WHAT CONTRIBUTES. Only passages of THIS session's project and cluster, embedded under THIS session's pinned model (EC-23: a vector
// from another model is not queryable from here at all), embedded already, and not expired (NFR-OPT-04). A passage still waiting for
// its vector, or whose weight is 0 (it adds nothing to the vector, so it must not add to the count either), is neither averaged nor counted - the disclosed source count is the number of passages the centroid is actually made of.
//
// The result is written onto the session (centroid, centroid_source_count, centroid_domains) in the same statement, so the figure
// disclosed to the user can never disagree with the vector it describes. "Low confidence" has no column: it is derived from the
// disclosed count (isLowConfidence), so it cannot drift from it either.

export interface CentroidResult {
  /** False when the session does not exist (or is not this workspace's): nothing was written. */
  readonly found: boolean;
  readonly sourceCount: number;
  readonly domains: readonly string[];
  readonly hasCentroid: boolean;
  readonly lowConfidence: boolean;
}

const NOT_FOUND: CentroidResult = { found: false, sourceCount: 0, domains: [], hasCentroid: false, lowConfidence: true };

export async function computeCentroid(tx: ClientBase, sessionId: string): Promise<CentroidResult> {
  const result = await tx.query<{ centroid_source_count: number; centroid_domains: string[]; has_centroid: boolean }>(
    `WITH s AS (
       SELECT id, project_id, prompt_cluster_id, embedding_model
         FROM geo_alignments
        WHERE id = $1 AND workspace_id = app.current_workspace()
     ), agg AS (
       SELECT s.id,
              count(cp.id)::int AS n,
              COALESCE(array_agg(DISTINCT cp.domain ORDER BY cp.domain) FILTER (WHERE cp.id IS NOT NULL), '{}') AS domains,
              COALESCE(sum(cp.centroid_weight::double precision), 0) AS total_weight,
              sum(cp.embedding::vector(1536) * array_fill(cp.centroid_weight, ARRAY[1536])::vector(1536)) FILTER (WHERE cp.id IS NOT NULL) AS weighted_sum
         FROM s
         LEFT JOIN corpus_passages cp
                ON cp.workspace_id = app.current_workspace()
               AND cp.project_id = s.project_id
               AND cp.prompt_cluster_id IS NOT DISTINCT FROM s.prompt_cluster_id
               AND cp.embedding_model = s.embedding_model
               AND cp.embedding IS NOT NULL
               AND cp.centroid_weight > 0
               AND cp.expires_at > now()
        GROUP BY s.id
     )
     UPDATE geo_alignments g
        SET centroid = CASE WHEN agg.n > 0 AND agg.total_weight > 0 THEN l2_normalize(agg.weighted_sum)::halfvec(1536) END,
            centroid_source_count = agg.n,
            centroid_domains = agg.domains,
            updated_at = now()
       FROM agg
      WHERE g.id = agg.id AND g.workspace_id = app.current_workspace()
     RETURNING g.centroid_source_count, g.centroid_domains, g.centroid IS NOT NULL AS has_centroid`,
    [sessionId],
  );
  const row = result.rows[0];
  if (row === undefined) return NOT_FOUND;
  return {
    found: true,
    sourceCount: row.centroid_source_count,
    domains: row.centroid_domains,
    hasCentroid: row.has_centroid,
    lowConfidence: isLowConfidence(row.centroid_source_count),
  };
}

import type { ClientBase } from "pg";

// STORY-045 AC6 - §4 step 5 DEDUPE:
//
//   5. DEDUPE   embed all 15 in one batched call -> pgvector cosine against existing project prompts; reject at cosine >= 0.92,
//               keeping the earlier prompt
//
// THREE PIECES, kept apart so each can be tested for what it is:
//   judgeVectors        pure. Turns the SQL's numbers into keep / reject. The threshold, the earlier-wins rule and the null-versus-0
//                       rule live here and nowhere else.
//   compareInSql        the cosine arithmetic. ALL of it in Postgres (pgvector, halfvec(1536), the HNSW index on tracked_prompts) -
//                       a vector never becomes a JavaScript number that is then multiplied.
//   VectorDedupePort    the seam generatePass takes: one `embed` call for the batch and one `compare` round trip.
//
// WHERE THE VECTORS COME FROM IS NOT DECIDED HERE. `embed` is whatever the caller injects. NFR-ARCH-01 forbids an embedding-provider call
// from a request handler and eslint refuses the port's import outside the embed.batch handler, so nothing in src/modules binds an
// embedder today - see PROMPT_CANDIDATE_EMBEDDER (modules/prompts/ports/candidate-embedder.ts).

/** tracking-engine.md section 4 step 5; schemas/projects-and-prompts.md `embedding` row: "generation dedupe (>= 0.92)". */
export const VECTOR_DEDUPE_THRESHOLD = 0.92;

export interface NearestExisting {
  readonly promptId: string;
  readonly cosine: number;
}

export interface BatchPair {
  /** Indices into the batch; `earlier` < `later`. */
  readonly earlier: number;
  readonly later: number;
  readonly cosine: number;
}

export interface VectorComparison {
  /** Per batch index: the nearest embedded prompt of the project, or null when the project has none to compare against. */
  readonly nearest: readonly (NearestExisting | null)[];
  /** Every pair WITHIN the batch at or above the threshold. */
  readonly batchPairs: readonly BatchPair[];
}

export interface VectorVerdict {
  readonly reject: boolean;
  /** The existing prompt a rejected candidate collided with. Null for a within-batch collision (the kept one has no id yet) and when kept. */
  readonly conflictingPromptId: string | null;
  /** The highest cosine to an EXISTING prompt. null = nothing was compared; 0 = compared and orthogonal. Never conflated. */
  readonly maxCosine: number | null;
  readonly nearestPromptId: string | null;
}

export interface VectorDedupePort {
  /** ONE call for the whole batch; one vector per text, in order. */
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
  /** ONE SQL round trip for the whole batch. The model name the vectors were produced under is the comparer's concern. */
  compare(vectors: readonly (readonly number[])[]): Promise<VectorComparison>;
}

export function judgeVectors(comparison: VectorComparison, threshold: number = VECTOR_DEDUPE_THRESHOLD): readonly VectorVerdict[] {
  const rejected = new Set<number>();
  return comparison.nearest.map((nearest, index) => {
    const maxCosine = nearest === null ? null : Math.min(1, Math.max(0, nearest.cosine));
    const nearestPromptId = nearest?.promptId ?? null;

    if (nearest !== null && nearest.cosine >= threshold) {
      rejected.add(index);
      return { reject: true, conflictingPromptId: nearest.promptId, maxCosine, nearestPromptId };
    }
    // Earlier wins, and only a KEPT earlier prompt can reject a later one: A~B and B~C with A!~C rejects B and keeps C, because C is
    // not a duplicate of anything that stays in the project.
    const collidesInBatch = comparison.batchPairs.some(
      (pair) => pair.later === index && pair.cosine >= threshold && !rejected.has(pair.earlier),
    );
    if (collidesInBatch) {
      rejected.add(index);
      return { reject: true, conflictingPromptId: null, maxCosine, nearestPromptId };
    }
    return { reject: false, conflictingPromptId: null, maxCosine, nearestPromptId };
  });
}

/** A pgvector text literal. A vector is data here, bound as a parameter and cast in SQL, never interpolated into the statement. */
function literal(vector: readonly number[]): string {
  return JSON.stringify(vector);
}

// $1 batch indices, $2 vector literals, $3 project id, $4 embedding model.
//   `ORDER BY embedding <=> v LIMIT 1` is the shape the HNSW index serves. `embedding_model = $4` is the EC-23 rule: a vector from
//   another model lives in a different space, and comparing across spaces is meaningless, so a prompt embedded under another model is
//   simply not a neighbour. `deleted_at IS NULL` matches the live-prompt predicate dedupe uses everywhere else.
const NEAREST_SQL = `
  SELECT c.i AS idx, n.id AS prompt_id, n.cosine::float8 AS cosine
    FROM unnest($1::int[], $2::text[]) AS c(i, v)
    LEFT JOIN LATERAL (
      SELECT p.id, 1 - (p.embedding <=> c.v::halfvec(1536)) AS cosine
        FROM tracked_prompts p
       WHERE p.project_id = $3 AND p.deleted_at IS NULL
         AND p.embedding IS NOT NULL AND p.embedding_model = $4
       ORDER BY p.embedding <=> c.v::halfvec(1536)
       LIMIT 1
    ) n ON true
   ORDER BY c.i`;

// $1 indices, $2 literals, $3 threshold. Pairs within the batch, earlier index first.
const BATCH_PAIRS_SQL = `
  WITH c AS (SELECT i, v::halfvec(1536) AS v FROM unnest($1::int[], $2::text[]) AS t(i, v))
  SELECT a.i AS earlier, b.i AS later, (1 - (a.v <=> b.v))::float8 AS cosine
    FROM c a JOIN c b ON a.i < b.i
   WHERE 1 - (a.v <=> b.v) >= $3::float8
   ORDER BY a.i, b.i`;

/**
 * The comparison against the whole project and within the batch. Runs on the caller's tenant-context client, so RLS bounds the project
 * (NFR-SEC-01); the `project_id` predicate is for the planner and the index, not for correctness.
 */
export async function compareInSql(
  client: Pick<ClientBase, "query">,
  projectId: string,
  model: string,
  vectors: readonly (readonly number[])[],
  threshold: number = VECTOR_DEDUPE_THRESHOLD,
): Promise<VectorComparison> {
  if (vectors.length === 0) return { nearest: [], batchPairs: [] };
  const indices = vectors.map((_, index) => index);
  const literals = vectors.map(literal);

  const nearest = await client.query<{ idx: number; prompt_id: string | null; cosine: number | null }>(NEAREST_SQL, [
    indices,
    literals,
    projectId,
    model,
  ]);
  const pairs = await client.query<{ earlier: number; later: number; cosine: number }>(BATCH_PAIRS_SQL, [indices, literals, threshold]);

  return {
    nearest: nearest.rows.map((row) => (row.prompt_id === null || row.cosine === null ? null : { promptId: row.prompt_id, cosine: row.cosine })),
    batchPairs: pairs.rows.map((row) => ({ earlier: row.earlier, later: row.later, cosine: row.cosine })),
  };
}

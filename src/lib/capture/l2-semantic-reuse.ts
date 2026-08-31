import type { ClientBase } from "pg";

// STORY-032 — tracking-engine.md §6's L2 near-duplicate probe.
//
// §6's admission rules, all six of which must hold: same project, same
// engine, cosine >= 0.94, source captured within 0.5x the engine's L1 TTL,
// source `status='parsed'`, and the source NOT ITSELF an L2 reuse.
//
// ONE QUERY FOR THE WHOLE BATCH, and that is an acceptance criterion rather
// than an optimisation. A per-cell query makes planning cost scale with run
// size: a project with hundreds of cells would spend longer planning than
// capturing, and the cost is invisible until a large project appears. The
// LATERAL below runs the HNSW index once per candidate cell inside a single
// round trip — the shape that keeps this O(1) in round trips.

/**
 * §6: "cosine >= 0.94".
 *
 * Pinned by a test against the literal, not merely imported by one. An
 * assertion that compares a fixture to this constant moves with it: the
 * review set this to 0.80 and 0.5 below to 0.3, and all 1399 tests stayed
 * green.
 */
export const L2_COSINE_THRESHOLD = 0.94;

/** §6: "source captured within 0.5x the engine's L1 TTL". Pinned the same way, for the same reason. */
export const L2_WINDOW_FRACTION = 0.5;

export interface L2Candidate {
  readonly promptId: string;
  readonly engineKey: string;
  readonly sampleIndex: number;
  /** THIS engine's `cache_ttl_seconds`; the reuse window is half of it. */
  readonly ttlSeconds: number;
}

export interface L2Hit {
  readonly promptId: string;
  readonly engineKey: string;
  readonly sampleIndex: number;
  /** The capture being reused — recorded as `source_result_id` on the suppressed row. */
  readonly sourceResultId: string;
  /**
   * The source's content hash, carried out with the hit.
   *
   * Returned here so the row writer does not have to go back for it. Its
   * LEFT JOIN on `source.id` looked harmless and was not: `id` alone is not
   * indexed — the primary key is (captured_at, id) — so it sequentially
   * scanned every partition of answer_captures on every planning call that
   * suppressed an L2 cell. The probe is already reading this row.
   */
  readonly sourceContentHash: Buffer;
  readonly cosine: number;
}

/**
 * The identity of one cell within a run — an in-memory Map key, never a
 * Valkey key.
 *
 * Separated by a pipe rather than a colon deliberately. ISO-13 flagged the
 * colon-separated version as an un-namespaced cache key and was RIGHT to:
 * in this codebase a colon-joined interpolated string means a Valkey key,
 * and a reader encountering one here would reasonably look for the namespace
 * it appears to be missing. (This sentence avoids spelling the shape out for
 * the same reason — the scanner reads comments too, and it should. A gate
 * that skipped comments could be evaded by writing the key in one.)
 * The gate was not widened to accommodate this; the string
 * was made unambiguous instead.
 */
export function cellKey(cell: { promptId: string; engineKey: string; sampleIndex: number }): string {
  return `${cell.promptId}|${cell.engineKey}|${String(cell.sampleIndex)}`;
}

/**
 * The batch probe.
 *
 * Returns at most one hit per candidate: the nearest admissible source. The
 * caller suppresses those cells and dispatches the rest.
 *
 * Note what this does NOT do — it does not copy the parse output. §6 requires
 * a reuse to re-run entity matching against the CURRENT alias set, so that an
 * alias added yesterday appears in a reused cell. Copying wholesale here
 * would make the matrix quietly disagree with the customer's own
 * configuration, so the copy belongs to the capture worker that acts on the
 * suppression, never to the probe that finds it.
 */
export async function probeSemanticReuse(
  tx: ClientBase,
  scope: { readonly workspaceId: string; readonly projectId: string },
  candidates: readonly L2Candidate[],
): Promise<Map<string, L2Hit>> {
  const hits = new Map<string, L2Hit>();
  if (candidates.length === 0) return hits;

  // THE WIDEST WINDOW ANY CANDIDATE COULD ADMIT, as a scalar.
  //
  // The per-row bound below is derived from `c.ttl_seconds` and so varies
  // per candidate, which leaves Postgres unable to prune partitions with it:
  // measured on a 15-partition table, the planner scanned ALL FIFTEEN and
  // demoted `captured_at` to a per-row Filter — every partition of the
  // highest-volume table in the platform, touched once per candidate, on the
  // planning path.
  //
  // This constant is deliberately REDUNDANT and deliberately LOOSER: taking
  // the maximum means it can never exclude a row the per-row bound would
  // have admitted, so it changes no result. Being scalar, it prunes. The
  // same measurement with it in place removes 10 of the 15 subplans and
  // turns `captured_at` into an index condition.
  // Reduced rather than spread. `Math.max(...array)` passes every element as
  // a call argument, and a project with enough prompts to overflow the
  // engine's argument limit would fail here with a RangeError — on the
  // planning path, for the largest tenants only, in code whose whole purpose
  // is to make large batches cheap.
  const maxWindowSeconds =
    candidates.reduce((widest, c) => (c.ttlSeconds > widest ? c.ttlSeconds : widest), 0) * L2_WINDOW_FRACTION;

  // The candidate list travels as ONE array parameter per column and is
  // unnested server-side, so the statement text is identical for a run of
  // three cells and a run of three hundred. Building an IN list instead
  // would produce a new query plan per run size and defeat the prepared
  // statement cache.
  const result = await tx.query<{
    prompt_id: string;
    engine_key: string;
    sample_index: number;
    source_result_id: string;
    source_content_hash: Buffer;
    cosine: number;
  }>(
    `
    WITH candidate AS (
      -- ONE json parameter rather than four parallel arrays. Multi-argument
      -- unnest() inside a CTE leaves Postgres unable to deduce the parameter
      -- types ("inconsistent types deduced for parameter $4"), and naming the
      -- columns here is clearer than four positional casts besides.
      SELECT * FROM jsonb_to_recordset($2::jsonb)
        AS c(prompt_id uuid, engine_key text, sample_index int, ttl_seconds int)
    )
    SELECT c.prompt_id, c.engine_key, c.sample_index, s.source_result_id, s.source_content_hash, s.cosine
      FROM candidate c
      -- BOTH SIDES OF THE COMPARISON ARE PROJECT-SCOPED. The source filters
      -- below were here from the start; the TARGET had none, so a cell whose
      -- prompt belonged to another project could be matched against this
      -- project's captures. RLS does not cover it: it holds the WORKSPACE
      -- boundary and has nothing to say about a project boundary inside one.
      -- Found by the STORY-032 second-engineer review, which reproduced it
      -- under correct tenant context.
      JOIN tracked_prompts target ON target.id = c.prompt_id AND target.project_id = $1
      -- JOIN LATERAL ... ON true, not CROSS JOIN LATERAL: the subquery may
      -- return no admissible source, and CROSS JOIN would then drop the row
      -- with no way to distinguish "no source" from "never asked".
      JOIN LATERAL (
        SELECT ac.id AS source_result_id,
               ac.content_hash AS source_content_hash,
               1 - (source_prompt.embedding <=> target.embedding) AS cosine
          FROM answer_captures ac
          JOIN tracked_prompts source_prompt ON source_prompt.id = ac.prompt_id
         -- TWO project filters, and they are deliberately redundant: the
         -- CAPTURE's project and its PROMPT's project must both be this
         -- project. Mutation testing shows either alone refuses a
         -- cross-project source, so rule 1's test proves the property
         -- without pinning which clause enforces it. Both stay — a capture
         -- whose prompt belongs to another project is corrupt either way,
         -- and this is the query that must not act on it.
         -- WORKSPACE FIRST, and not for tenancy — RLS already holds that
         -- boundary. It is the LEADING COLUMN of every usable index on this
         -- table, and omitting it left the planner on
         -- the (run_id, status) index, scanning it for every parsed row
         -- ever captured. Naming it here is what makes the project, engine
         -- and time columns reachable.
         WHERE ac.workspace_id = $5
           AND ac.project_id = $1                             -- same project (the capture)
           AND ac.engine_key = c.engine_key                   -- same engine
           AND ac.status = 'parsed'                           -- source fully parsed
           AND ac.cache_layer <> 'l2'                         -- NO TRANSITIVE CHAINS
           -- The prunable bound, then the exact one. See maxWindowSeconds.
           AND ac.captured_at >= now() - make_interval(secs => $6::double precision)
           AND ac.captured_at >= now() - make_interval(secs => (c.ttl_seconds * $3::double precision))
           AND source_prompt.project_id = $1                   -- same project (its prompt)
           AND source_prompt.embedding IS NOT NULL
           AND target.embedding IS NOT NULL
           AND 1 - (source_prompt.embedding <=> target.embedding) >= $4
         ORDER BY source_prompt.embedding <=> target.embedding
         LIMIT 1
      ) s ON true
    `,
    [
      scope.projectId,
      JSON.stringify(
        candidates.map((c) => ({
          prompt_id: c.promptId,
          engine_key: c.engineKey,
          sample_index: c.sampleIndex,
          ttl_seconds: c.ttlSeconds,
        })),
      ),
      L2_WINDOW_FRACTION,
      L2_COSINE_THRESHOLD,
      scope.workspaceId,
      maxWindowSeconds,
    ],
  );

  for (const row of result.rows) {
    hits.set(cellKey({ promptId: row.prompt_id, engineKey: row.engine_key, sampleIndex: row.sample_index }), {
      promptId: row.prompt_id,
      engineKey: row.engine_key,
      sampleIndex: row.sample_index,
      sourceResultId: row.source_result_id,
      sourceContentHash: row.source_content_hash,
      cosine: Number(row.cosine),
    });
  }
  return hits;
}

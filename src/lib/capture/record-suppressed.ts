import type { ClientBase } from "pg";

// STORY-032 — AC9 and AC12. What a run writes for the cells it did NOT
// capture, and the counters it records before dispatching the ones it did.
//
// tracking-engine.md §5: "Cells suppressed by L1 or L2 still produce an
// `answer_captures` row with `cache_layer` and `source_result_id`, so the
// prompt matrix is never sparse. They do NOT increment `captured_cells`, do
// NOT consume the fair-use cap, and are excluded from accuracy measurement."
//
// THE ROW IS WHAT KEEPS THE MATRIX HONEST. Omitting a suppressed cell would
// make a cached cell indistinguishable from a failed one — both absent — and
// an interface cannot label what it cannot see. A gap would read as "this
// engine had nothing to say", which is a claim about the engine rather than
// about our own cost optimisation.

/**
 * An L1 hit answers from the shared cross-tenant answer cache, so there is no
 * prior row of ours to point at — the content hash comes from the cached
 * entry itself. An L2 hit reuses one of THIS project's own captures, so it
 * points at that row and copies its hash from it.
 *
 * A discriminated union rather than optional fields, so "l1 with a source
 * id" and "l2 without one" are both unrepresentable rather than merely
 * discouraged.
 */
export type SuppressedCell =
  | {
      readonly layer: "l1";
      readonly promptId: string;
      readonly engineKey: string;
      readonly sampleIndex: number;
      readonly contentHash: Buffer;
      /**
       * The shared answer itself, from the L1 entry.
       *
       * REQUIRED, not optional. An L1 row cannot borrow its content from
       * anywhere else: unlike an L2 row it has no `source_result_id`, because
       * the capture it shares belongs to another tenant. If the answer does
       * not arrive here it exists nowhere in this workspace, and the row is
       * unscoreable forever while reading to any aggregation as "the brand
       * was absent". Making it required is what stops that row being
       * writable at all.
       */
      readonly payload: Record<string, unknown>;
      readonly excerpt: string | null;
      readonly adapterVersion: string;
    }
  | {
      readonly layer: "l2";
      readonly promptId: string;
      readonly engineKey: string;
      readonly sampleIndex: number;
      readonly sourceResultId: string;
      readonly adapterVersion: string;
    };

export interface SuppressedRowContext {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly normalizerVersion: string;
  readonly captureMode: "api" | "licensed_serp" | "headless";
  /**
   * The project's alias set AS IT IS NOW — never the source capture's.
   *
   * AC7: "A reuse re-runs entity matching against the current alias set, so
   * an alias added yesterday is reflected in a reused cell." Stamping the
   * CURRENT fingerprint is what makes that enforceable rather than merely
   * intended: whatever parses this row later compares against this value, so
   * a row carrying the source's fingerprint would look already-matched
   * against an alias set that has since moved, and the competitor added
   * yesterday would never appear.
   */
  readonly aliasFingerprint: Buffer;
}

/**
 * Writes one `answer_captures` row per suppressed cell, in ONE statement.
 *
 * `status = 'skipped'` — no live capture happened here, and that is the
 * honest value. The parse-output copy and the re-run of entity matching
 * against the CURRENT alias set (§6) belong to the worker that acts on the
 * suppression, not to the planner that finds it: copying at plan time would
 * bake in yesterday's alias set and make the matrix quietly disagree with the
 * customer's own configuration.
 *
 * For an L2 row the content hash is copied FROM THE SOURCE inside the
 * statement rather than passed in, so it cannot drift from the row it claims
 * to reuse.
 */
export async function recordSuppressedCells(
  tx: ClientBase,
  context: SuppressedRowContext,
  cells: readonly SuppressedCell[],
): Promise<number> {
  if (cells.length === 0) return 0;

  const payload = cells.map((cell) => ({
    prompt_id: cell.promptId,
    engine_key: cell.engineKey,
    sample_index: cell.sampleIndex,
    cache_layer: cell.layer,
    adapter_version: cell.adapterVersion,
    source_result_id: cell.layer === "l2" ? cell.sourceResultId : null,
    content_hash: cell.layer === "l1" ? cell.contentHash.toString("hex") : null,
    // L1 carries the answer inline; L2 leaves it where the source already
    // holds it, reachable through source_result_id inside this tenant.
    payload: cell.layer === "l1" ? cell.payload : null,
    excerpt: cell.layer === "l1" ? cell.excerpt : null,
  }));

  const result = await tx.query(
    `
    -- THE SCORED COLUMNS ARE DELIBERATELY ABSENT FROM THIS INSERT.
    --
    -- brand_present, sov, sentiment_label, sentiment_score,
    -- brand_rank_position, citation_count and owned_citation_count are left
    -- at their defaults, so a reused cell arrives UNSCORED. Copying them from
    -- the source is the obvious shortcut and is what AC7 forbids: those
    -- values were produced by matching against the alias set as it stood
    -- then, and an alias added since would never appear. §6 requires a reuse
    -- to "re-run entity matching against the current alias set", and a row
    -- that already carries scores is a row nothing will re-match.
    INSERT INTO answer_captures
      (workspace_id, project_id, run_id, prompt_id, engine_key, sample_index, captured_at,
       capture_mode, adapter_version, normalizer_version, content_hash,
       cache_layer, source_result_id, alias_fingerprint, status, payload, response_excerpt)
    SELECT $1, $2, $3, c.prompt_id, c.engine_key, c.sample_index, now(),
           $4, c.adapter_version, $5,
           -- An L2 row's hash is COPIED from the capture it reuses, so the
           -- two cannot disagree about what was answered. An L1 row's comes
           -- from the shared cache entry, which is the only thing that has it.
           COALESCE(decode(c.content_hash, 'hex'), source.content_hash),
           -- The CURRENT fingerprint, never source.alias_fingerprint. See
           -- SuppressedRowContext.aliasFingerprint.
           c.cache_layer, c.source_result_id, $7, 'skipped',
           -- THE ANSWER, for an L1 row. §6: "storage happens per tenant
           -- AFTER the cache read" — the read is what supplies the thing
           -- stored. An L2 row leaves these at their defaults because
           -- source_result_id already reaches the answer inside this tenant.
           COALESCE(c.payload, '{}'::jsonb), c.excerpt
      FROM jsonb_to_recordset($6::jsonb)
        AS c(prompt_id uuid, engine_key text, sample_index int, cache_layer text,
             adapter_version text, source_result_id uuid, content_hash text,
             payload jsonb, excerpt text)
      LEFT JOIN answer_captures source ON source.id = c.source_result_id
     -- IDEMPOTENT PER RUN. The ux_results_cell index cannot enforce it: it is
     -- (run_id, prompt_id, engine_key, sample_index, captured_at), and
     -- captured_at is now() — a fresh value on every attempt — so ON
     -- CONFLICT never fires and a replan wrote a SECOND row for the same
     -- cell. The unique index cannot drop captured_at either, because
     -- Postgres requires a partitioned table's unique index to include the
     -- partition key. Hence the explicit guard.
     --
     -- Replanning is not an edge case: it is the documented recovery when a
     -- crash lands between the plan committing and the jobs being enqueued.
     -- Before this, that recovery doubled every suppressed row while
     -- skipped_cells still said one, so the matrix counted a cached cell
     -- twice against a denominator that counted it once.
     WHERE NOT EXISTS (
       SELECT 1 FROM answer_captures prior
        WHERE prior.run_id = $3
          AND prior.prompt_id = c.prompt_id
          AND prior.engine_key = c.engine_key
          AND prior.sample_index = c.sample_index
     )
    `,
    [
      context.workspaceId,
      context.projectId,
      context.runId,
      context.captureMode,
      context.normalizerVersion,
      JSON.stringify(payload),
      context.aliasFingerprint,
    ],
  );
  return result.rowCount ?? 0;
}

export interface RunCounts {
  readonly planned: number;
  readonly skipped: number;
}

/**
 * AC12 — the run's counters, recorded BEFORE any job is enqueued.
 *
 * Before, and that ordering is the requirement rather than a preference. A
 * run whose jobs are dispatched first and counted second has a window in
 * which workers are already reporting progress against a denominator that
 * does not exist: `captured_cells` climbs past `planned_cells` of zero, and a
 * progress projection built on it reads as complete, or as nonsense, before
 * the plan is durable at all.
 *
 * `captured_cells` is deliberately NOT touched. §5 is explicit that a
 * suppressed cell does not advance the live-capture count — that counter is
 * the workers' to increment as real captures land, and pre-seeding it with
 * suppressions would report work that never happened.
 */
export async function recordRunCounts(tx: ClientBase, runId: string, counts: RunCounts): Promise<void> {
  const result = await tx.query(
    `UPDATE capture_runs
        SET planned_cells = $2,
            skipped_cells = $3
      WHERE id = $1`,
    [runId, counts.planned, counts.skipped],
  );

  // AN UPDATE THAT MATCHED NOTHING IS NOT A RECORDED COUNT.
  //
  // `UPDATE ... WHERE id = $1` reports success having changed no rows, so
  // without this check the one thing AC12 requires to happen BEFORE dispatch
  // could silently not happen at all, and the caller would go on to enqueue.
  // The run then reports `planned_cells = 0` while workers increment
  // `captured_cells` against it — the exact zero denominator the ordering
  // rule exists to prevent, reached by a different route.
  //
  // RLS is what makes this likely rather than theoretical. `capture_runs`
  // carries FORCE ROW LEVEL SECURITY, so a missing or wrong
  // `app.current_workspace_id` does not raise — the row simply becomes
  // invisible and the UPDATE matches nothing. A tenant-context bug would
  // present as runs that quietly never record a plan, which is close to the
  // hardest failure to trace back to its cause.
  if (result.rowCount !== 1) {
    throw new Error(
      `recordRunCounts: expected to update exactly 1 capture_runs row for ${runId}, updated ${String(result.rowCount ?? 0)} — ` +
        "the run does not exist, or is invisible under the current tenant context",
    );
  }
}

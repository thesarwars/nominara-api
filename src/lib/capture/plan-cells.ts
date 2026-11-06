import type { ClientBase } from "pg";
import { captureReadyEngineKeys } from "../engines/registry.js";

// STORY-032 — tracking-engine.md §5's cell planning: engine resolution,
// prompt selection, and the fan-out across prompts x engines x samples.
//
// This is the spine both cache probes plug into. It answers "what would this
// run capture if nothing were cached"; L1 and L2 then remove from that set,
// and what survives is dispatched.

/** §5: a run covers all active prompts, or the priority subset. */
export type PromptScope = "all" | "priority" | "cluster";

export interface PlannedCell {
  readonly promptId: string;
  readonly promptText: string;
  readonly engineKey: string;
  readonly sampleIndex: number;
  /** THIS engine's cache TTL, which the L1 bucket and the L2 window are both derived from. */
  readonly ttlSeconds: number;
  /** For the L1 key, which an adapter MAJOR invalidates — see l1-cache-key.ts. */
  readonly adapterVersion: string;
}

export interface ResolvedEngine {
  readonly engineKey: string;
  readonly sampleCount: number;
  readonly ttlSeconds: number;
  readonly adapterVersion: string;
}

/**
 * The engines this run may capture, filtered by ENTITLEMENT.
 *
 * Three conditions, each excluding a different thing:
 *
 *   `project_engines.enabled` — the customer's own choice.
 *   `engines.status = 'active'` — ours. A disabled or beta engine is not
 *   dispatched to merely because a project asked for it.
 *   `min_plan.sort_order <= workspace_plan.sort_order` — the entitlement.
 *
 * The entitlement is resolved by COMPARING PLAN ORDER IN THE DATABASE, not by
 * parsing a tier name like "3_core" out of the entitlements document and
 * mapping it to engine keys in code. AC1 requires that "a plan change takes
 * effect on the next run with no redeploy", and a compiled-in mapping would
 * need one — the same defect STORY-025's AC10 records for rate-limit buckets.
 * `engines.min_plan_key` already declares each engine's floor and
 * `plans.sort_order` already orders the plans, so nothing needs inventing and
 * an engine moving tier is a row change.
 *
 * An explicit `engineKeys` filter narrows and can never widen: a caller
 * asking for an engine the workspace is not entitled to gets nothing back,
 * rather than an error that would let it probe the entitlement set.
 */
/**
 * ⚠ ENTITLED AND CAPTURE-READY ARE TWO DIFFERENT THINGS, and this returns the
 * intersection. STORY-152.
 *
 * The catalog says what a plan BUYS; `registry.ts` says what this build can
 * actually ask. Today those disagree completely — every active engine is
 * fixture-backed, so `captureReadyEngineKeys()` is empty and this returns []
 * for every project on every plan.
 *
 * That is not the same "[]" this function returned before STORY-152, and the
 * difference is the whole point. It used to be empty because `project_engines`
 * had no production writer — the product silently believed no project was
 * entitled to anything. It is empty now because nothing in this repository can
 * capture yet, which is true and is fixed by STORY-001 opening vendor accounts.
 */
export async function resolveEnabledEngines(
  tx: ClientBase,
  projectId: string,
  engineKeys?: readonly string[],
  /**
   * ⚠ A SEAM, NOT A CONVENIENCE. Production never passes this: the default is
   * the registry's own derived list, so the honest empty set is what the
   * scheduler and every handler actually get.
   *
   * It exists because the capture-path integration specs are about the RUN
   * LIFECYCLE — dispatch, progress, suppression, failure — and cannot exercise
   * any of it while no engine is capture-ready. They pass the keys they seeded.
   * The one test that asserts what PRODUCTION resolves omits it, which is what
   * keeps the default from being an unfalsifiable one.
   */
  captureReady: readonly string[] = captureReadyEngineKeys(),
): Promise<ResolvedEngine[]> {
  const result = await tx.query<{
    engine_key: string;
    sample_count: number;
    cache_ttl_seconds: number;
    adapter_version: string;
  }>(
    `
    -- THE VIEW, NOT project_engines. STORY-152.
    --
    -- This query used to be driven by project_engines — which has never had a
    -- production writer, so it resolved ZERO cells for every real project and
    -- a run was planned with nothing in it. The entitled set is DERIVED now:
    -- the view's driving table is engines, and an override enters through a
    -- LEFT JOIN, so it can only narrow.
    --
    -- The plan floor and the cadence predicate live in the view rather than
    -- here, which is the point: they were correct in this file and in
    -- engine-cadence.ts, and absent from the four other readers.
    SELECT pes.engine_key, pes.sample_count, pes.cache_ttl_seconds, pes.adapter_version
      FROM project_entitled_engines pes
     WHERE pes.project_id = $1
       AND pes.enabled
       -- CAPTURE-READY ONLY. An engine can be entitled and still have no
       -- adapter that could answer; planning a cell for one manufactures a
       -- failure out of something we never attempted. See registry.ts.
       AND pes.engine_key = ANY($3::text[])
       AND ($2::text[] IS NULL OR pes.engine_key = ANY($2::text[]))
     ORDER BY pes.engine_key
    `,
    [projectId, engineKeys === undefined ? null : [...engineKeys], [...captureReady]],
  );

  return result.rows.map((row) => ({
    engineKey: row.engine_key,
    sampleCount: row.sample_count,
    ttlSeconds: row.cache_ttl_seconds,
    adapterVersion: row.adapter_version,
  }));
}

/**
 * The prompts this run covers.
 *
 * `priority` takes the project's own `priority_prompt_limit`, ordered so the
 * subset is STABLE across runs — priority first, then oldest first, then by
 * id. An unordered LIMIT would sample a different subset each run, and a time
 * series assembled from a shifting subset is not a time series: the chart
 * would move because the question set moved, not because the answers did.
 */
export async function selectPrompts(
  tx: ClientBase,
  projectId: string,
  scope: PromptScope,
  /** STORY-067: required by (and only read for) the `cluster` scope - a verification run covers the task's cluster, not the project. */
  clusterId: string | null = null,
): Promise<{ id: string; text: string }[]> {
  const result = await tx.query<{ id: string; text: string }>(
    `
    SELECT id, text
      FROM tracked_prompts
     WHERE project_id = $1
       AND status = 'active'
       AND CASE $2 WHEN 'priority' THEN is_priority
                   WHEN 'cluster' THEN cluster_id = $3::uuid
                   ELSE true END
     ORDER BY is_priority DESC, created_at ASC, id ASC
     LIMIT CASE WHEN $2 = 'priority'
                THEN (SELECT priority_prompt_limit FROM projects WHERE id = $1)
                ELSE NULL END
    `,
    [projectId, scope, clusterId],
  );
  return result.rows;
}

/**
 * §5's fan-out: every prompt x every engine x that engine's sample count.
 *
 * Sample count is PER ENGINE rather than per run, because it is a property of
 * the engine's own variability. One run-wide number would either over-sample
 * the stable engines — paying for observations that add nothing — or
 * under-sample the volatile ones, publishing a figure drawn from too few.
 */
export function fanOutCells(
  prompts: readonly { id: string; text: string }[],
  engines: readonly ResolvedEngine[],
): PlannedCell[] {
  const cells: PlannedCell[] = [];
  for (const prompt of prompts) {
    for (const engine of engines) {
      for (let sampleIndex = 0; sampleIndex < engine.sampleCount; sampleIndex += 1) {
        cells.push({
          promptId: prompt.id,
          promptText: prompt.text,
          engineKey: engine.engineKey,
          sampleIndex,
          ttlSeconds: engine.ttlSeconds,
          adapterVersion: engine.adapterVersion,
        });
      }
    }
  }
  return cells;
}

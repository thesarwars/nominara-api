import type { ClientBase } from "pg";
import { captureReadyEngineKeys } from "../engines/registry.js";

// STORY-033 AC4 and AC5 — per-engine due-ness, and the record that makes it
// reconstructable.
//
// THE TWO ACs ARE ONE LOOP, which is why they live in one file.
//
// AC5 requires the run row to record exactly which engines it covered.
// AC4 requires each engine's due-ness to be resolved independently. The
// second READS what the first WRITES: "when was this engine last captured
// for this project" has no other source, because a run covers a different
// engine set every time and `capture_runs.created_at` alone cannot say which
// engines were in it.
//
// schemas/captures-and-facts.md is explicit that this is the ONLY source:
// "`cadence_by_plan` x `project_engines.enabled` is the only source the
// scheduler reads and the only source the per-engine freshness row renders,
// which is why the customer-visible cadence cannot drift from what actually
// runs." So there is deliberately no fallback here.
//
// STORY-152 — that sentence still holds, through one more hop: this reads
// `project_entitled_engines`, and the view's `cadence` column IS
// `cadence_by_plan -> <this workspace's plan>`. The scheduler and the
// customer-visible freshness row now read the same expression from the same
// relation, which is what FR-CRD-09's "it cannot drift from the scheduler"
// actually asks for. `project_engines.enabled` reaches this query through
// the view's LEFT JOIN, as `pes.enabled`.

/**
 * §5's cadence table is stated in runs per 30-day cycle, so the interval
 * between two runs of the same engine is `30 days / runs`.
 *
 * A cycle rather than a calendar month: the figures customers are shown
 * ("4 runs", "8 runs") are per cycle, and deriving an interval from a
 * variable-length month would make February's cadence quietly faster than
 * March's for the same plan.
 */
export const CYCLE_DAYS = 30;
const CYCLE_MS = CYCLE_DAYS * 24 * 60 * 60 * 1000;

/**
 * The two run kinds `cadence_by_plan` carries, per
 * schemas/captures-and-facts.md's own example:
 *
 *   {"starter":{"full":4},"growth":{"full":8},"business":{"full":4,"priority":26}}
 *
 * `full` is the whole prompt set; `priority` is the subset, and only the
 * plans whose §5 cadence has one carry the key at all.
 */
export type RunKind = "full" | "priority";

/** §5's `prompt_scope` names the same split from the run's side. */
export function scopeForKind(kind: RunKind): "all" | "priority" {
  return kind === "full" ? "all" : "priority";
}

export interface DueEngine {
  readonly engineKey: string;
  /** From `cadence_by_plan[plan][kind]` — runs per 30-day cycle. */
  readonly runsPerCycle: number;
  /** `CYCLE_MS / runsPerCycle`, the gap this engine is due after. */
  readonly intervalMs: number;
  /** Null when this engine has never been covered for this project. */
  readonly lastCoveredAt: Date | null;
}

/**
 * The engines due for `kind` on this project, right now.
 *
 * INDEPENDENTLY PER ENGINE, which is the whole of AC4: a project on a plan
 * whose Perplexity cadence is 26/cycle and whose Claude cadence is 4/cycle
 * covers both on Sunday and only Perplexity on Tuesday. Resolving one
 * due-ness for the project and applying it to every engine would produce a
 * uniform run that the freshness row would then misreport.
 *
 * FOUR CONDITIONS, and each excludes something different. STORY-152 moved
 * three of them into `project_entitled_engines`; they are still four, and
 * the view is where three now live:
 *
 *   `pes.enabled` — the customer's choice, via the view's LEFT JOIN to
 *   `project_engines`. An override narrows; it can never widen.
 *   `e.status = 'active'` — ours, now IN THE VIEW; a degraded or beta engine
 *   is not scheduled into merely because a project enabled it.
 *   plan order — the entitlement, now IN THE VIEW, compared in the database
 *   for the same reason `resolveEnabledEngines` does it: a compiled-in
 *   mapping would need a redeploy for a plan change.
 *   the cadence entry — whether this plan schedules this engine at all. THIS
 *   ONE STAYS HERE, and deliberately: see FAIL CLOSED.
 *
 * ⚠ THE CATALOG IS SEEDED NOW — migration 0027, STORY-152. This comment used
 * to say the opposite ("NOTHING SEEDS IT ... the scheduler covers no engines"),
 * and a reader who believed it would conclude this function is inert and ship
 * a worker on that basis. It is not inert: it returns real due engines for a
 * real project the moment a caller exists.
 *
 * ⚠ CAPTURE-READINESS IS A FIFTH CONDITION, AND IT IS APPLIED HERE RATHER
 * THAN LEFT TO THE PLANNER. `captureReadyEngineKeys()` is `[]` today because
 * every engine is fixture-backed. Without this filter, a scheduled tick would
 * find engines due, write a `capture_runs` row, resolve ZERO cells, and
 * record `engine_keys = '{}'` — which the `last_run` LATERAL below cannot
 * match, so `last_covered_at` would stay NULL and the same engine would be
 * due again on every tick, forever, accumulating permanently-`queued` runs
 * that nothing can complete.
 *
 * Filtering here instead makes the due set empty, and `planScheduledRun`'s
 * existing "nothing is due" path returns before it inserts anything. That
 * path is older than this story and already tested; the alternative was to
 * delete a row we had just written, which is a second mechanism to get right.
 *
 * FAIL CLOSED. An engine whose plan has no cadence entry is NOT due, rather
 * than due by default. The two mistakes are not symmetric: scheduling an
 * engine the plan does not include spends money on a vendor call the
 * customer is not paying for and inflates their fair-use counter, while
 * failing to schedule one shows up as a stale freshness row that somebody
 * can see. This mirrors `CAPTURABLE_WORKSPACE_STATUSES` being an allow-list.
 */
export async function resolveDueEngines(
  tx: ClientBase,
  input: {
    readonly projectId: string;
    readonly kind: RunKind;
    readonly now: Date;
  },
  /**
   * ⚠ A TEST SEAM, AND PRODUCTION NEVER PASSES IT. STORY-152 — the default
   * IS the production value, and it is empty. See the fifth condition above.
   */
  captureReady: readonly string[] = captureReadyEngineKeys(),
): Promise<DueEngine[]> {
  const result = await tx.query<{
    engine_key: string;
    runs_per_cycle: number;
    last_covered_at: Date | null;
  }>(
    `
    -- THE VIEW, NOT project_engines. STORY-152 — see plan-cells.ts.
    -- pes.cadence is already cadence_by_plan -> this workspace's plan, so the
    -- scheduler and the customer-visible freshness row read the SAME
    -- expression from the same place, which is what FR-CRD-09's "it cannot
    -- drift from the scheduler" actually asks for.
    SELECT pes.engine_key,
           (pes.cadence ->> $2)::int AS runs_per_cycle,
           last_run.covered_at       AS last_covered_at
      FROM project_entitled_engines pes
      -- When this engine was last actually covered for this project. AC5's
      -- engine_keys is the only record of it; a run's created_at cannot
      -- answer it, because each run covers a different set.
      LEFT JOIN LATERAL (
        SELECT max(r.created_at) AS covered_at
          FROM capture_runs r
         WHERE r.project_id = pes.project_id
           AND r.engine_keys @> ARRAY[pes.engine_key]
           -- A run that failed or was canceled did not cover the engine, and
           -- treating it as coverage would push the next capture a whole
           -- interval away on the strength of work that never happened.
           AND r.status <> ALL (ARRAY['failed', 'canceled'])
      ) last_run ON true
     WHERE pes.project_id = $1
       AND pes.enabled
       -- Capture-readiness, the fifth condition. Empty in production, so this
       -- excludes everything and no scheduled run is planned at all -- which
       -- is the honest state until an adapter story binds a real adapter.
       AND pes.engine_key = ANY($3::text[])
       -- status active and the plan floor are in the view now. THE CADENCE
       -- TEST IS NOT, AND MUST STAY HERE: the view lists every engine the
       -- plan ENTITLES, including the ones it entitles on demand and never
       -- schedules (STORY-130 §57's "tools only" free tier). This line is the
       -- whole of FAIL CLOSED above -- pes.cadence is NULL when the plan has
       -- no entry, NULL ->> $2 is NULL, and NULL::int > 0 is not true, so an
       -- entitled-but-uncadenced engine is never due. It also covers the
       -- KIND-specific case (a plan with full and no priority schedules no
       -- priority run) and rejects a seeded 0, which would divide by zero.
       AND (pes.cadence ->> $2)::int > 0
     ORDER BY pes.engine_key
    `,
    [input.projectId, input.kind, [...captureReady]],
  );

  const due: DueEngine[] = [];
  for (const row of result.rows) {
    const intervalMs = CYCLE_MS / row.runs_per_cycle;
    const lastCoveredAt = row.last_covered_at;
    // Never covered is always due — a newly enabled engine should not wait a
    // full interval before its first capture, or a project's first run would
    // silently cover nothing.
    if (lastCoveredAt !== null && input.now.getTime() - lastCoveredAt.getTime() < intervalMs) {
      continue;
    }
    due.push({
      engineKey: row.engine_key,
      runsPerCycle: row.runs_per_cycle,
      intervalMs,
      lastCoveredAt,
    });
  }
  return due;
}

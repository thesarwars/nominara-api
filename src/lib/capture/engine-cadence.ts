import type { ClientBase } from "pg";

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
// runs." So there is deliberately no fallback here — see UNSEEDED CATALOG
// below for what that costs today.

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
 * FOUR CONDITIONS, and each excludes something different:
 *
 *   `pe.enabled` — the customer's choice.
 *   `e.status = 'active'` — ours; a degraded or beta engine is not scheduled
 *   into merely because a project enabled it.
 *   plan order — the entitlement, compared IN THE DATABASE for the same
 *   reason `resolveEnabledEngines` does it: a compiled-in mapping would need
 *   a redeploy for a plan change.
 *   the cadence entry — whether this plan schedules this engine at all.
 *
 * UNSEEDED CATALOG. `engines.cadence_by_plan` defaults to `{}` and NOTHING
 * SEEDS IT — there is no `INSERT INTO engines` anywhere in `src/`, and no
 * story owns one. So in production this returns an empty set for every
 * project and the scheduler covers no engines. That is the correct behaviour
 * for the data as it stands (see FAIL CLOSED), not a bug in this function,
 * but it means AC4 is inert until the catalog is seeded. Recorded in the
 * story rather than papered over with a fallback.
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
): Promise<DueEngine[]> {
  const result = await tx.query<{
    engine_key: string;
    runs_per_cycle: number;
    last_covered_at: Date | null;
  }>(
    `
    SELECT pe.engine_key,
           (e.cadence_by_plan -> w.plan_key ->> $2)::int AS runs_per_cycle,
           last_run.covered_at                           AS last_covered_at
      FROM project_engines pe
      JOIN projects p            ON p.id = pe.project_id
      JOIN workspaces w          ON w.id = p.workspace_id
      JOIN engines e             ON e.key = pe.engine_key
      JOIN plans engine_plan     ON engine_plan.key = e.min_plan_key
      JOIN plans workspace_plan  ON workspace_plan.key = w.plan_key
      -- When this engine was last actually covered for this project. AC5's
      -- engine_keys is the only record of it; a run's created_at cannot
      -- answer it, because each run covers a different set.
      LEFT JOIN LATERAL (
        SELECT max(r.created_at) AS covered_at
          FROM capture_runs r
         WHERE r.project_id = pe.project_id
           AND r.engine_keys @> ARRAY[pe.engine_key]
           -- A run that failed or was canceled did not cover the engine, and
           -- treating it as coverage would push the next capture a whole
           -- interval away on the strength of work that never happened.
           AND r.status <> ALL (ARRAY['failed', 'canceled'])
      ) last_run ON true
     WHERE pe.project_id = $1
       AND pe.enabled
       AND e.status = 'active'
       AND engine_plan.sort_order <= workspace_plan.sort_order
       -- Fail closed: no cadence entry for this plan means this plan does not
       -- schedule this engine. The > 0 test also rejects a seeded 0, which
       -- would otherwise divide by zero below.
       AND (e.cadence_by_plan -> w.plan_key ->> $2)::int > 0
     ORDER BY pe.engine_key
    `,
    [input.projectId, input.kind],
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

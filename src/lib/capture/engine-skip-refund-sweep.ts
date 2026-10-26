import { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";
import { settleEngineSkippedCells } from "../credits/engine-skip-refund.js";
import { ENGINE_UNAVAILABLE_SKIP_CODES } from "../engines/capture-engine-gate.js";
import { blockedStatusSql } from "../rollup/aggregate-day.js";
import { incrementCounter } from "../telemetry/metrics.js";

// STORY-031 — OWNER DECISION 2026-10-26 (10): the sweep that settles engine-skip refunds (engine-skip-refund.ts).
//
// WHY A SWEEP AND NOT THE FINALISING CELL. The last cell finalises its run inside capture.execute's COMMIT transaction, and that
// transaction also enqueues (the parse job, the rollup request) and touches the cache: a ledger write there would share a
// transaction with network I/O, which ADR-0003 / NFR-ARCH-04 forbid and the owner's brief rules out for this refund. The
// capture.execute phasing (STORY-181) is left exactly as it is. A run the stuck-run reaper finalises is covered the same way.
//
// So the refund rides the capture group's hourly scheduler tick (scheduler-sweep.ts), after the reapers: the owner connection
// FINDS candidates (ids only, no tenant content), and each is settled in ITS OWN tenant transaction holding nothing but the
// settlement's own statements. A candidate is a terminal `partial` manual run, finished inside the lookback, with at least one
// engine-unavailable blocked cell and no refund yet. Idempotent end to end: a second tick, a second replica, or a crash between
// two runs changes nothing that was already settled (see engine-skip-refund.ts).
//
// LATENCY, DISCLOSED: the refund lands at the next :05 UTC tick after the run finishes, not at the moment it does.

const logger = new Logger("capture.engine-skip-refund-sweep");

/** How far back a finished run is still considered. Generous: the predicate (no refund yet) is what keeps a pass cheap. */
export const ENGINE_SKIP_REFUND_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const BATCH_LIMIT = 200;

export interface EngineSkipRefundSweepResult {
  readonly refundedRuns: number;
}

/** `client` is the sweep's OWNER connection, with no transaction open on it. */
export async function sweepEngineSkipRefunds(client: ClientBase, now: Date, options: { readonly lookbackMs?: number } = {}): Promise<EngineSkipRefundSweepResult> {
  const since = new Date(now.getTime() - (options.lookbackMs ?? ENGINE_SKIP_REFUND_LOOKBACK_MS));
  const candidates = await client.query<{ id: string; workspace_id: string }>(
    `SELECT r.id, r.workspace_id
       FROM capture_runs r
      WHERE r.status = 'partial'
        AND r.trigger = 'manual'
        AND r.finished_at >= $1
        AND EXISTS (SELECT 1 FROM answer_captures a
                     WHERE a.run_id = r.id AND ${blockedStatusSql("a.status")} AND a.error_code = ANY($2::text[]))
        AND NOT EXISTS (SELECT 1 FROM credit_ledger l
                         WHERE l.workspace_id = r.workspace_id AND l.entry_type = 'refund'
                           AND l.reference_type = 'run' AND l.reference_id = r.id)
      ORDER BY r.finished_at
      LIMIT $3`,
    [since, [...ENGINE_UNAVAILABLE_SKIP_CODES], BATCH_LIMIT],
  );

  let refundedRuns = 0;
  for (const candidate of candidates.rows) {
    try {
      const outcome = await withTenantContext(client, { workspaceId: candidate.workspace_id, actorId: SYSTEM_ACTOR_ID }, (tx) =>
        settleEngineSkippedCells(tx, { workspaceId: candidate.workspace_id, runId: candidate.id }),
      );
      if (outcome.refunded > 0) refundedRuns += 1;
    } catch (error) {
      incrementCounter("nominara_credits_engine_skip_refund_failed_total", {});
      logger.error({ event: "credits.engine_skip_refund.failed", workspace_id: candidate.workspace_id, run_id: candidate.id, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return { refundedRuns };
}

import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase, Pool, PoolClient } from "pg";
import { STALE_SENDING_MS } from "../../modules/reports/scheduled-reports.service.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";
import { incrementCounter } from "../telemetry/metrics.js";

// STORY-183 - the sweep that makes storage match what reads already show. Send-now records a delivery `sending` and finishes it after commit
// (Group C, option B); a process that dies in between leaves the row `sending`. Reads show such a row as `failed` once it is older than
// STALE_SENDING_MS on the database clock; this rewrites the row, sets the report's `last_error`, and counts the delivery once, as `failed`.
//
// WHO WINS A RACE. Both this and the late finaliser (`ScheduledReportsService.finalize`) are `UPDATE ... WHERE status = 'sending'` on the same
// row. Under READ COMMITTED the second waits for the first's row lock, re-checks the predicate against the committed row, and matches nothing:
// whichever commits first stands, and the loser neither rewrites the row nor touches `last_error` nor counts a metric.
//
// WHERE IT RUNS. In the report group's elected 5-minute tick (`ReportSweepRuntime.after`, the STORY-178 precedent), so it is single-flight
// across replicas by the advisory lock, and idempotent besides (a second run finds nothing). Discovery reads workspace ids across tenants on the
// owner connection; each workspace is then rewritten in its OWN tenant transaction on the runtime pool, so RLS applies to the writes.
//
// LAST_ERROR IS NOT CLOBBERED. If the report already has a NEWER delivery that settled (delivered, logged, failed, skipped), that delivery owns
// `last_error` (a success clears it); the swept row is still rewritten, but it does not overwrite a newer outcome.

export const STALE_SENDING_REASON = "delivery did not complete: the sending process did not report back";
/** One tick takes at most this many workspaces; the rest are still stale and are taken by the next tick. */
export const STALE_SWEEP_BATCH = 500;

const logger = new Logger("reports.stale-sweep");
const tracer = trace.getTracer("nominara.reports");

export interface StaleSweepConnections {
  /** The owner connection: sees across tenants. */
  readonly discovery: ClientBase;
  /** The runtime pool: each workspace is rewritten in its own tenant transaction on it. */
  readonly work: Pool;
}

export interface StaleSweepOutcome {
  readonly workspacesChecked: number;
  readonly swept: number;
  readonly failures: readonly { workspaceId: string; reason: string }[];
}

export async function sweepStaleSendingDeliveries(connections: StaleSweepConnections): Promise<StaleSweepOutcome> {
  return tracer.startActiveSpan("reports.stale_delivery_sweep", async (span) => {
    try {
      const outcome = await run(connections);
      span.setAttribute("nominara.reports.stale_sweep.workspaces", outcome.workspacesChecked);
      span.setAttribute("nominara.reports.stale_sweep.swept", outcome.swept);
      span.setAttribute("nominara.reports.stale_sweep.failed", outcome.failures.length);
      if (outcome.failures.length > 0) span.setStatus({ code: SpanStatusCode.ERROR });
      incrementCounter("nominara_reports_stale_sweep_runs_total", { status: outcome.failures.length === 0 ? "complete" : "partial" });
      // Counts only: never a report name, a recipient or an address.
      logger.log({ event: "reports.stale_sweep", workspaces: outcome.workspacesChecked, swept: outcome.swept, failed: outcome.failures.length });
      return outcome;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      incrementCounter("nominara_reports_stale_sweep_runs_total", { status: "failed" });
      throw error;
    } finally {
      span.end();
    }
  });
}

async function run({ discovery, work }: StaleSweepConnections): Promise<StaleSweepOutcome> {
  // Loose "worth looking at" list; the rewrite below re-checks the predicate under the row lock.
  const found = await discovery.query<{ workspace_id: string }>(
    `SELECT DISTINCT workspace_id
       FROM scheduled_report_deliveries
      WHERE status = 'sending' AND now() - attempted_at > $1 * interval '1 millisecond'
      ORDER BY workspace_id
      LIMIT $2`,
    [STALE_SENDING_MS, STALE_SWEEP_BATCH],
  );
  let swept = 0;
  const failures: { workspaceId: string; reason: string }[] = [];
  for (const { workspace_id: workspaceId } of found.rows) {
    let client: PoolClient | undefined;
    try {
      client = await work.connect();
      const count = await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) => rewriteWorkspace(tx));
      swept += count;
      // After the commit, once per rewritten delivery: a delivery the finaliser won was never rewritten and is counted by the finaliser.
      for (let i = 0; i < count; i += 1) incrementCounter("nominara_reports_scheduled_deliveries_total", { status: "failed" });
    } catch (error) {
      // Class or pg code only: a database message can carry values.
      const code = (error as { code?: unknown } | null)?.code;
      failures.push({ workspaceId, reason: typeof code === "string" ? code : error instanceof Error ? error.name : "unknown" });
      logger.error({ event: "reports.stale_sweep.workspace_failed", workspace_id: workspaceId, reason: failures.at(-1)?.reason });
    } finally {
      client?.release();
    }
  }
  return { workspacesChecked: found.rows.length, swept, failures };
}

/** ONE statement: rewrite the stale rows (guarded by `status = 'sending'`) and set `last_error` on their reports. Returns how many rows it rewrote. */
async function rewriteWorkspace(tx: ClientBase): Promise<number> {
  const result = await tx.query<{ swept: number }>(
    `WITH swept AS (
       UPDATE scheduled_report_deliveries
          SET status = 'failed', reason = $2
        WHERE status = 'sending' AND now() - attempted_at > $1 * interval '1 millisecond'
        RETURNING scheduled_report_id, attempted_at
     ),
     latest AS (SELECT scheduled_report_id, max(attempted_at) AS at FROM swept GROUP BY scheduled_report_id),
     marked AS (
       UPDATE scheduled_reports r SET last_error = $2
         FROM latest l
        WHERE r.id = l.scheduled_report_id
          AND NOT EXISTS (SELECT 1 FROM scheduled_report_deliveries d
                           WHERE d.scheduled_report_id = r.id AND d.attempted_at > l.at AND d.status <> 'sending')
        RETURNING r.id
     )
     SELECT (SELECT count(*) FROM swept)::int AS swept, (SELECT count(*) FROM marked)::int AS marked`,
    [STALE_SENDING_MS, STALE_SENDING_REASON],
  );
  return result.rows[0]?.swept ?? 0;
}

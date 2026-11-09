import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase } from "pg";
import { incrementCounter } from "../telemetry/metrics.js";

// STORY-114 / STORY-115 - the producers of `attribution.rollup` (hourly) and `gsc.sync` (daily at 04:00 UTC).
//
// WHY A SWEEP AND NOT A CRON. Both queues are tenant-scoped: every job carries a workspace id and an HMAC signature, so a bare BullMQ
// cron cannot feed them and the schedule registrar refuses their rows (schedule.ts keeps the cadences as statements of intent). This
// sweep reads across tenants on the OWNER connection, as src/lib/topics/sweep.ts does, and enqueues one signed job per due project or
// connection. It holds no transaction and makes no network call but the enqueue (ADR-0003).
//
// DUE
//   attribution.rollup  every project with a RECEIVING beacon configuration, once per UTC hour: key `attr:{project}:{hour}`.
//   gsc.sync            every live connection whose credential has not been revoked, once per UTC day from 04:00, when it has not already
//                       committed since that moment: key `gsc:{connection}:{day}`, the SAME key the manual route and the OAuth callback use,
//                       so a manual press and the daily run are one job. A backfill that lost its continuation is picked up here the next
//                       day, because the watermark only moves on a commit.
//
// A repeated tick inside the hour or day is the same job (the key), so ticking more often than the cadence costs nothing.

const logger = new Logger("attribution.sweep");
const tracer = trace.getTracer("nominara-api");

export const GSC_DAILY_SYNC_HOUR_UTC = 4;

export type EnqueueTenantJob = (queue: "attribution.rollup" | "gsc.sync", workspaceId: string, payload: Record<string, unknown>, options: { readonly idempotencyKey: string }) => Promise<unknown>;

export interface AttributionSweepResult {
  readonly status: "complete" | "partial";
  readonly rollupDue: number;
  readonly gscDue: number;
  readonly enqueued: number;
  readonly failed: number;
}

export class AttributionSweepBlindError extends Error {
  constructor(who: string) {
    super(`the attribution sweep is connected as "${who}", which neither bypasses row-level security nor is a superuser: it would find nothing due and look healthy`);
    this.name = "AttributionSweepBlindError";
  }
}

export const rollupJobKey = (projectId: string, now: Date): string => `attr:${projectId}:${now.toISOString().slice(0, 13)}`;
export const gscJobKey = (connectionId: string, now: Date): string => `gsc:${connectionId}:${now.toISOString().slice(0, 10)}`;

/** `04:00 UTC` of `now`'s day, or `null` before it: a connection is not due earlier than the cadence. */
export function gscCadenceStart(now: Date): Date | null {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), GSC_DAILY_SYNC_HOUR_UTC));
  return now.getTime() >= start.getTime() ? start : null;
}

/** One pass on `client`, an owner connection that sees across tenants. */
export async function runAttributionSweep(client: ClientBase, enqueue: EnqueueTenantJob, now: Date): Promise<AttributionSweepResult> {
  const role = await client.query<{ can_see: boolean; who: string }>("SELECT (rolsuper OR rolbypassrls) AS can_see, rolname AS who FROM pg_roles WHERE rolname = current_user");
  if (role.rows[0]?.can_see !== true) {
    incrementCounter("nominara_attribution_sweep_runs_total", { status: "blind" });
    throw new AttributionSweepBlindError(role.rows[0]?.who ?? "unknown");
  }
  return await tracer.startActiveSpan("attribution.sweep", async (span) => {
    try {
      const rollups = await client.query<{ workspace_id: string; project_id: string }>(
        `SELECT DISTINCT p.workspace_id, p.id AS project_id
           FROM attribution_configs c
           JOIN projects p ON p.id = c.project_id AND p.workspace_id = c.workspace_id AND p.deleted_at IS NULL
          WHERE c.status = 'receiving'
          ORDER BY p.id`,
      );
      const cadenceStart = gscCadenceStart(now);
      const connections =
        cadenceStart === null
          ? { rows: [] as Array<{ workspace_id: string; id: string }> }
          : await client.query<{ workspace_id: string; id: string }>(
              `SELECT g.workspace_id, g.id
                 FROM gsc_connections g
                 JOIN projects p ON p.id = g.project_id AND p.workspace_id = g.workspace_id AND p.deleted_at IS NULL
                WHERE g.revoked_at IS NULL AND g.health_status NOT IN ('unauthorized', 'revoked')
                  AND (g.last_sync_at IS NULL OR g.last_sync_at < $1::timestamptz)
                ORDER BY g.id`,
              [cadenceStart],
            );

      let enqueued = 0;
      let failed = 0;
      const attempt = async (queue: "attribution.rollup" | "gsc.sync", workspaceId: string, payload: Record<string, unknown>, key: string): Promise<void> => {
        try {
          await enqueue(queue, workspaceId, payload, { idempotencyKey: key });
          enqueued += 1;
          incrementCounter("nominara_attribution_sweep_jobs_enqueued_total", { queue });
        } catch (error) {
          failed += 1;
          incrementCounter("nominara_attribution_sweep_enqueue_failures_total", { queue });
          logger.error({ event: "attribution.sweep.enqueue_failed", queue, workspace_id: workspaceId, error: error instanceof Error ? error.name : "unknown" });
        }
      };
      for (const row of rollups.rows) await attempt("attribution.rollup", row.workspace_id, { projectId: row.project_id }, rollupJobKey(row.project_id, now));
      for (const row of connections.rows) await attempt("gsc.sync", row.workspace_id, { connectionId: row.id }, gscJobKey(row.id, now));

      const status = failed === 0 ? "complete" : "partial";
      incrementCounter("nominara_attribution_sweep_runs_total", { status });
      span.setAttributes({ "nominara.attribution.sweep.rollup_due": rollups.rows.length, "nominara.attribution.sweep.gsc_due": connections.rows.length, "nominara.attribution.sweep.enqueued": enqueued, "nominara.attribution.sweep.failed": failed });
      logger.log({ event: "attribution.sweep", status, rollup_due: rollups.rows.length, gsc_due: connections.rows.length, enqueued, failed });
      return { status, rollupDue: rollups.rows.length, gscDue: connections.rows.length, enqueued, failed } as const;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

/** The sweep as the worker runs it: its failure is its OWN signal, counted and logged, never silent, and never another sweep's failure. */
export async function runAttributionSweepIsolated(client: ClientBase, enqueue: EnqueueTenantJob, now: Date): Promise<void> {
  try {
    await runAttributionSweep(client, enqueue, now);
  } catch (error) {
    incrementCounter("nominara_attribution_sweep_failures_total");
    logger.error({ event: "attribution.sweep.failed", error: error instanceof Error ? error.name : "unknown" });
  }
}

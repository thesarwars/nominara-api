import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase } from "pg";
import { releaseAdvisorySessionLock, tryAdvisorySessionLock } from "../queue/locks.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { reportBuildJobKey } from "./run-scheduled-report.js";

// STORY-100 AC5 — THE REPORT SWEEP: the producer of `report.build`, in-process in the REPORT worker group (where the queue's
// handler runs), on the capture scheduler-sweep / notify-sweep precedent. Owner-confirmed 2026-10-26: `schedule.ts` keeps
// `report.build` at `cron: null`, because this is not a fixed cron on the queue. It is a per-report sweep over
// `scheduled_reports.next_send_at`.
//
// WHY A SWEEP AND NOT A CRON. `report.build` is TENANT-scoped: every job is signed for one workspace, so a bare BullMQ cron
// (no workspace) cannot feed it (schedule-registrar.ts refuses such a row as inert). The sweep reads ids across every
// workspace on the OWNER connection and enqueues one signed job per due report and period; the job builds in that
// workspace's own tenant context. The sweep reads `id`, `workspace_id` and `next_send_at` and nothing else: no name, no
// recipient, no figure. It writes nothing.
//
// IT ENQUEUES; IT NEVER ADVANCES. The handler is the only thing that moves `next_send_at` (in the transaction that settles
// the period), so a sweep that is wrong, late or run twice cannot skip or duplicate a period: until the handler settles it,
// the report is still due with the SAME `next_send_at`, so every tick derives the same job key (`rep:{report}:{period}`) and
// the queue returns the original job.
//
// ELECTED, AND NO TRANSACTION IS HELD. Every replica ticks; a tick runs only if it takes the session advisory lock
// `report.sweep` on its own DIRECT, non-pooled connection (try-lock, never a wait; released at the end and by the
// connection's end). Nothing here opens a transaction, so none is held across an enqueue (network I/O, NFR-ARCH-04).
//
// A FAILED ENQUEUE does not stop the batch: it is counted, logged with ids, reported as `partial`, and asked again next tick.

const logger = new Logger("reports.sweep");
const tracer = trace.getTracer("nominara.reports");

const MINUTE_MS = 60_000;

export const REPORT_SWEEP_LOCK = "report.sweep";
export const REPORT_SWEEP_STEP_MS = 5 * MINUTE_MS;
/** One tick enqueues at most this many reports; the rest are still due and are taken by the next tick, oldest first. */
export const REPORT_SWEEP_BATCH = 500;
export const REPORT_BUILD_QUEUE = "report.build" as const;

export interface DueReport {
  readonly reportId: string;
  readonly workspaceId: string;
  readonly period: Date;
}

/** Active reports whose period has come, oldest first. `client` sees across tenants (the owner connection). */
export async function findDueReports(client: ClientBase, now: Date, limit: number = REPORT_SWEEP_BATCH): Promise<DueReport[]> {
  const result = await client.query<{ id: string; workspace_id: string; next_send_at: Date }>(
    `SELECT id, workspace_id, next_send_at
       FROM scheduled_reports
      WHERE active AND next_send_at IS NOT NULL AND next_send_at <= $1
      ORDER BY next_send_at, id
      LIMIT $2`,
    [now, limit],
  );
  return result.rows.map((row) => ({ reportId: row.id, workspaceId: row.workspace_id, period: new Date(row.next_send_at) }));
}

export type EnqueueReportBuild = (
  queue: typeof REPORT_BUILD_QUEUE,
  workspaceId: string,
  payload: { readonly reportId: string; readonly period: string },
  options: { readonly idempotencyKey: string },
) => Promise<unknown>;

export interface ReportSweepResult {
  readonly status: "complete" | "partial";
  readonly due: number;
  readonly enqueued: number;
  readonly failed: number;
}

export class ReportSweepBlindError extends Error {
  constructor(who: string) {
    super(`the report sweep is connected as "${who}", which neither bypasses row-level security nor is a superuser: it would find no report due and look healthy`);
    this.name = "ReportSweepBlindError";
  }
}

/** One pass on `client`, an owner connection that sees across tenants. */
export async function runReportSweep(client: ClientBase, enqueue: EnqueueReportBuild, now: Date): Promise<ReportSweepResult> {
  const role = await client.query<{ can_see: boolean; who: string }>("SELECT (rolsuper OR rolbypassrls) AS can_see, rolname AS who FROM pg_roles WHERE rolname = current_user");
  if (role.rows[0]?.can_see !== true) {
    incrementCounter("nominara_reports_sweep_runs_total", { status: "blind" });
    throw new ReportSweepBlindError(role.rows[0]?.who ?? "unknown");
  }
  return await tracer.startActiveSpan("reports.sweep", async (span) => {
    try {
      const due = await findDueReports(client, now);
      let enqueued = 0;
      let failed = 0;
      for (const report of due) {
        try {
          await enqueue(
            REPORT_BUILD_QUEUE,
            report.workspaceId,
            { reportId: report.reportId, period: report.period.toISOString() },
            { idempotencyKey: reportBuildJobKey(report.reportId, report.period) },
          );
          enqueued += 1;
          incrementCounter("nominara_reports_sweep_jobs_enqueued_total");
        } catch (error) {
          failed += 1;
          incrementCounter("nominara_reports_sweep_enqueue_failures_total");
          // Ids only: never a report name, a recipient or an address.
          logger.error({ event: "reports.sweep.enqueue_failed", workspace_id: report.workspaceId, scheduled_report_id: report.reportId, error: error instanceof Error ? error.name : "unknown" });
        }
      }
      const status = failed === 0 ? "complete" : "partial";
      incrementCounter("nominara_reports_sweep_runs_total", { status });
      span.setAttributes({ "nominara.reports.sweep.due": due.length, "nominara.reports.sweep.enqueued": enqueued, "nominara.reports.sweep.failed": failed });
      logger.log({ event: "reports.sweep", status, due: due.length, enqueued, failed });
      return { status, due: due.length, enqueued, failed } as const;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

type SweepClient = ClientBase & { end(): Promise<void> };

export interface ReportSweepRuntimeOptions {
  /** A NEW direct (never pooled, never pgBouncer) owner-role connection per tick; the runtime ends it. */
  readonly connect: () => Promise<SweepClient>;
  readonly enqueue: EnqueueReportBuild;
  readonly clock?: () => Date;
}

/** The in-process timer the report worker owns: a tick every 5 minutes, elected, best-effort, never crashes the worker. */
export class ReportSweepRuntime {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private inFlight = false;
  private readonly clock: () => Date;

  constructor(private readonly options: ReportSweepRuntimeOptions) {
    this.clock = options.clock ?? (() => new Date());
  }

  /** True between start() and stop(): the timer is armed (momentarily unset only while a tick runs). */
  get armed(): boolean {
    return this.running;
  }

  /** `null` when another replica held the lock, a tick was still running, or the pass failed (logged and counted). */
  async tick(): Promise<ReportSweepResult | null> {
    if (this.inFlight) return null;
    this.inFlight = true;
    let client: SweepClient | undefined;
    let locked = false;
    try {
      client = await this.options.connect();
      locked = await tryAdvisorySessionLock(client, REPORT_SWEEP_LOCK);
      if (!locked) {
        incrementCounter("nominara_reports_sweep_runs_total", { status: "not_elected" });
        return null;
      }
      return await runReportSweep(client, this.options.enqueue, this.clock());
    } catch (error) {
      incrementCounter("nominara_reports_sweep_runs_total", { status: "failed" });
      logger.error({ event: "reports.sweep.failed", error: error instanceof Error ? error.name : "unknown" });
      return null;
    } finally {
      if (client !== undefined && locked) await releaseAdvisorySessionLock(client, REPORT_SWEEP_LOCK).catch(() => false);
      await client?.end().catch(() => undefined);
      this.inFlight = false;
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.arm();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private arm(): void {
    const now = this.clock().getTime();
    const fireAt = (Math.floor(now / REPORT_SWEEP_STEP_MS) + 1) * REPORT_SWEEP_STEP_MS;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick().finally(() => {
        if (this.running) this.arm();
      });
    }, Math.max(0, fireAt - now));
    this.timer.unref();
  }
}

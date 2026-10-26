import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { z } from "zod";
import { selectEmailSender } from "../../../modules/identity/email-sender.selector.js";
import type { EmailSender } from "../../../modules/identity/ports/email-sender.js";
import { ExportService } from "../../../modules/reports/export.service.js";
import { MethodologyService } from "../../../modules/reports/methodology.service.js";
import { InMemoryCacheAdapter } from "../../cache/in-memory-cache.adapter.js";
import { EntitlementResolver } from "../../entitlements/entitlement-resolver.js";
import { StructuralUsage } from "../../entitlements/structural-usage.js";
import {
  commitPreparedRun,
  prepareScheduledRun,
  settleAfterFailure,
  sendPreparedRun,
  type PreparedRun,
  type ReportRunDeps,
  type RunOutcome,
} from "../../reports/run-scheduled-report.js";
import { incrementCounter } from "../../telemetry/metrics.js";
import type { QueueHandlerContext } from "../handlers.js";
import { PHASES_DONE, phasedProcessor, type JobProcessor } from "../worker-factory.js";

// STORY-100 AC5/AC12 — `report.build` (system-architecture.md §4: API or cron, report group, key `rep:{report}:{period}`).
// ONE scheduled report's ONE period: the cadence path of a scheduled report. A SIGNED TENANT job, PHASED (ADR-0003 /
// NFR-ARCH-04), on the notify.dispatch precedent: the logic lives in src/lib/reports/run-scheduled-report.ts (read its header
// for prepare / run / commit, idempotency and the failure rule); this file only binds it to a job.
//
// The payload is `.strict()` and carries ids and the period only: the recipients, the sections and the theme are read from
// the database, inside the job's tenant context. Its producer is the report sweep (src/lib/reports/report-sweep.ts); a
// manual "send now" never enqueues it (that path runs in the request, ScheduledReportsService.sendNow).
//
// RETRIES: the topology's ladder, doubling(3), so a delivery is attempted up to 4 times. The LAST attempt does not throw: it
// settles the period as failed, advances `next_send_at` and notifies the workspace with the reason (owner decision 7).

const tracer = trace.getTracer("nominara.report-build");

const payloadSchema = z
  .object({
    workspaceId: z.string().uuid(),
    kid: z.string(),
    reportId: z.string().uuid(),
    period: z.string().datetime(),
  })
  .strict();

export interface ReportBuildDeps {
  /** Injected in tests; production builds the export services over the worker's pool on first use. */
  readonly run?: ReportRunDeps;
  readonly sender?: EmailSender;
}

/**
 * Is this delivery the job's LAST? BullMQ increments `attemptsMade` when an attempt fails, so during attempt N it is N-1. An
 * absent `opts.attempts` (a hand-built job) is "not known to be final": the error is thrown and the queue decides.
 */
export function isFinalAttempt(job: Pick<Job, "attemptsMade" | "opts">): boolean {
  const attempts = job.opts?.attempts;
  if (attempts === undefined) return false;
  return (job.attemptsMade ?? 0) + 1 >= attempts;
}

export function createReportBuildHandler(context: QueueHandlerContext, deps: ReportBuildDeps = {}): JobProcessor {
  const logger = new Logger("report.build");
  // Built on first use, not at registration: QUEUE_HANDLERS is evaluated for every worker group at boot.
  let run = deps.run;
  const runDeps = (): ReportRunDeps => {
    if (run === undefined) {
      const resolver = new EntitlementResolver(new InMemoryCacheAdapter(), context.pool);
      const usage = new StructuralUsage(context.pool);
      run = { resolver, usage, exports: new ExportService(new MethodologyService(), resolver, usage, context.pool) };
    }
    return run;
  };
  let sender = deps.sender;
  const senderFor = (): EmailSender => (sender ??= selectEmailSender());

  return phasedProcessor<PreparedRun, RunOutcome>({
    async prepare(tx: ClientBase, job: Job) {
      const payload = payloadSchema.parse((job.data as { payload: unknown }).payload);
      const outcome = await prepareScheduledRun(tx, runDeps(), {
        workspaceId: payload.workspaceId,
        reportId: payload.reportId,
        period: new Date(payload.period),
        finalAttempt: isFinalAttempt(job),
      });
      if (outcome.kind === "settled") {
        incrementCounter("nominara_reports_build_jobs_total", { outcome: outcome.outcome });
        logger.log({ event: "report.build.settled", workspace_id: payload.workspaceId, scheduled_report_id: payload.reportId, outcome: outcome.outcome });
        return PHASES_DONE;
      }
      return outcome.prepared;
    },

    async run(prepared: PreparedRun) {
      return await tracer.startActiveSpan("report.build.send", async (span) => {
        span.setAttributes({ "nominara.workspace_id": prepared.workspaceId, "nominara.scheduled_report.id": prepared.reportId, "nominara.report.recipients": prepared.recipients.length });
        try {
          return await sendPreparedRun(senderFor(), prepared);
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          incrementCounter("nominara_reports_build_jobs_total", { outcome: "send_failed" });
          // Ids only: never an address, a label or the provider's own text.
          logger.warn({ event: "report.build.send_failed", workspace_id: prepared.workspaceId, scheduled_report_id: prepared.reportId, error: error instanceof Error ? error.name : "unknown" });
          throw error;
        } finally {
          span.end();
        }
      });
    },

    async commit(tx: ClientBase, prepared: PreparedRun, outcome: RunOutcome) {
      await commitPreparedRun(tx, runDeps(), prepared, outcome);
      incrementCounter("nominara_reports_build_jobs_total", { outcome: outcome.failed > 0 ? "failed" : "sent" });
      logger.log({ event: "report.build.done", workspace_id: prepared.workspaceId, scheduled_report_id: prepared.reportId, failed: outcome.failed });
    },

    // Owner decision 7 for ANY failure on the last attempt: advance the period and notify, in a fresh transaction. Before the
    // last attempt this declines, so the error reaches the queue and its ladder.
    async recover(tx: ClientBase, job: Job, failure) {
      if (!isFinalAttempt(job)) return false;
      const parsed = payloadSchema.safeParse((job.data as { payload: unknown }).payload);
      if (!parsed.success) return false;
      const { workspaceId, reportId } = parsed.data;
      const period = new Date(parsed.data.period);
      const settleFailed = (sentUnknown: boolean) => settleAfterFailure(tx, runDeps(), { workspaceId, reportId, period, error: failure.error, sentUnknown });
      if (failure.phase === "commit" && failure.prepared !== undefined && failure.fetched !== undefined) {
        // The emails went out: settle with what really happened rather than calling the period failed. A fault that recurs in this
        // fresh transaction must not wedge the period, so the attempt runs behind a savepoint and falls back to a failed settlement.
        await tx.query("SAVEPOINT report_recover");
        try {
          await commitPreparedRun(tx, runDeps(), failure.prepared, failure.fetched);
          await tx.query("RELEASE SAVEPOINT report_recover");
        } catch {
          await tx.query("ROLLBACK TO SAVEPOINT report_recover");
          await settleFailed(true);
        }
      } else {
        // A run-phase throw may have mailed some recipients first: the count is unknown, not zero.
        await settleFailed(failure.phase === "run");
      }
      incrementCounter("nominara_reports_build_jobs_total", { outcome: "recovered" });
      logger.warn({ event: "report.build.recovered", workspace_id: workspaceId, scheduled_report_id: reportId, phase: failure.phase, error: failure.error instanceof Error ? failure.error.name : "unknown" });
      return true;
    },
  });
}

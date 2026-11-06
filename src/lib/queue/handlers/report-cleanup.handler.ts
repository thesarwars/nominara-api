import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { connect, withKeepalives } from "../../../db/client.js";
import { runReportArtifactCleanup, type CleanupResult } from "../../reports/artifact-cleanup.js";
import { S3Adapter } from "../../storage/s3.adapter.js";
import { resolveStorageConfig } from "../../storage/storage-config.js";
import { TenantObjectStore } from "../../storage/tenant-object-store.js";
import { incrementCounter } from "../../telemetry/metrics.js";
import { globalQueueLockKey, releaseAdvisorySessionLock, tryAdvisorySessionLock } from "../locks.js";
import type { QueueHandlerContext } from "../handlers.js";
import type { JobProcessor } from "../worker-factory.js";

// STORY-180 r5 (owner decision 60 (b)) - `report.cleanup`: the nightly deletion of stored report files whose 7-day life has ended, and of
// half-uploaded ones. The work is `artifact-cleanup.ts` (object first, then the row; no storage I/O in a transaction); this is what makes it
// a scheduled job: the owner connection for cross-tenant discovery, the single-flight lock, and the span, metrics and log line.
//
// Not tenant-scoped, like `task.resurface`: the tick has no workspace to name. DEPLOY INVARIANT (shared with it): discovery reads
// `report_artifacts` across tenants, so DATABASE_URL must be a role that bypasses FORCE RLS; a role that does not would find nothing and
// the counter below would read zero every night. With object storage NOT configured the run is skipped and counted (there is nothing it
// could delete), never failed: a development stack without a bucket must not fill the dead-letter queue every night.
//
// Idempotent under at-least-once delivery (a second run finds nothing due, or deletes an already-absent object, which succeeds), and
// single-flight across replicas by the advisory lock, taken as a TRY: a replica that does not get it yields and loses nothing.

const tracer = trace.getTracer("nominara.report-cleanup");

export interface ReportCleanupDeps {
  readonly batchSize?: number;
  /** A test seam; production builds the store from the environment, as `report.build` does. */
  readonly store?: TenantObjectStore;
}

export type ReportCleanupOutcome = CleanupResult | { readonly status: "yielded" } | { readonly status: "skipped" };

export function createReportCleanupHandler(context: QueueHandlerContext, deps: ReportCleanupDeps = {}): JobProcessor<ReportCleanupOutcome> {
  const logger = new Logger("report.cleanup");

  // `_client` is the pooled connection `createJobProcessor` checks out for a non-tenant queue; this handler does not use it.
  return async (_client: ClientBase, _job: Job): Promise<ReportCleanupOutcome> => {
    let store = deps.store;
    if (store === undefined) {
      const config = resolveStorageConfig(context.env);
      if (config === null) {
        incrementCounter("nominara_reports_cleanup_skipped_total", { reason: "storage_unconfigured" });
        logger.warn({ event: "report.cleanup.skipped", reason: "storage_unconfigured" });
        return { status: "skipped" };
      }
      store = new TenantObjectStore(new S3Adapter(config), config.keyEnv);
    }

    const owner = await connect(withKeepalives(context.env.DATABASE_URL));
    const lockKey = globalQueueLockKey("report.cleanup");
    let held = false;
    try {
      held = await tryAdvisorySessionLock(owner, lockKey);
      if (!held) {
        incrementCounter("nominara_reports_cleanup_yielded_total");
        logger.warn({ event: "report.cleanup.yielded" });
        return { status: "yielded" };
      }
      return await tracer.startActiveSpan("report.cleanup", async (span) => {
        try {
          const result = await runReportArtifactCleanup(owner, context.pool, store, {
            ...(deps.batchSize === undefined ? {} : { batchSize: deps.batchSize }),
          });
          span.setAttribute("nominara.report_cleanup.purged", result.purged);
          span.setAttribute("nominara.report_cleanup.workspaces", result.workspaces);
          span.setAttribute("nominara.report_cleanup.failed", result.failed);
          span.setAttribute("nominara.report_cleanup.refused", result.refused);
          incrementCounter("nominara_reports_cleanup_runs_total", { status: result.status });
          // Counts only - never a key, an artifact id or a workspace name.
          logger.log({ event: "report.cleanup.run", status: result.status, purged: result.purged, workspaces: result.workspaces, failed: result.failed, refused: result.refused });
          // A partial run fails the job so the retry ladder is the prompt second try (the sweep is idempotent, so re-running costs nothing).
          if (result.failed > 0) throw new Error(`report cleanup: ${String(result.failed)} failure(s) - see the log`);
          return result;
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      });
    } finally {
      if (held && !(await releaseAdvisorySessionLock(owner, lockKey))) {
        logger.error({ event: "report.cleanup.lock_not_held_at_release" });
      }
      await owner.end();
    }
  };
}

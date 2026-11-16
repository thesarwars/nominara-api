import { Logger } from "@nestjs/common";
import { UnrecoverableError, type Job } from "bullmq";
import type { ClientBase } from "pg";
import type { Env } from "../../../config/env.schema.js";
import { connect, withKeepalives } from "../../../db/client.js";
import { LocalDirExportSink } from "../../../modules/audit/adapters/local-dir-export-sink.js";
import { S3ObjectLockExportSink } from "../../../modules/audit/adapters/s3-object-lock-export-sink.js";
import type { AuditExportSink } from "../../../modules/audit/ports/export-sink.js";
import { runAuditExport } from "../../../workers/rollup/audit-export.js";
import { incrementCounter, observeValue } from "../../telemetry/metrics.js";
import { globalQueueLockKey, releaseAdvisorySessionLock, tryAdvisorySessionLock } from "../locks.js";
import type { QueueHandlerContext } from "../handlers.js";
import type { JobProcessor } from "../worker-factory.js";

// STORY-020 AC8 - `audit.export`: security-and-tenancy.md section 12, "Nightly export to S3 with Object Lock in COMPLIANCE mode, 7-year
// retention." The streaming export (`runAuditExport`, STORY-144) and the sink port existed; nothing ran them nightly and the only sink was a
// chmod. This is the job, and the S3 Object Lock sink it selects when `AUDIT_EXPORT_BUCKET` is set.
//
// THE OWNER CONNECTION, because the export is cross-tenant by definition and `audit_log` is FORCE ROW LEVEL SECURITY: the pooled runtime role
// would see zero rows and "export" an empty estate successfully, the worst available outcome for evidence. Keepalives and a session advisory
// lock for the reasons `audit-verify.handler.ts` gives: one replica exports, the others yield, and a skipped tick loses nothing because the
// next one copies everything.
//
// NO SINK CONFIGURED: production FAILS CLOSED (an unrecoverable error, one dead-letter entry a night, because a compliance export that silently
// does not happen is the failure this job exists to prevent). Outside production it is a counted, logged skip so a developer's worker does not
// dead-letter nightly.
//
// ONE OPEN DEPENDENCY, a deploy prerequisite and not code: the bucket must exist with Object Lock ENABLED. Without it S3 refuses the lock headers,
// the upload fails, and so does this job.

export interface AuditExportHandlerDeps {
  readonly connect?: (url: string) => Promise<ClientBase & { end(): Promise<void> }>;
  readonly sinkFor?: (env: Env) => AuditExportSink | null;
  readonly runExport?: (client: ClientBase, sink: AuditExportSink) => Promise<string>;
}

/** The sink the environment selects: the Object Lock bucket first, else the local-directory approximation (AUDIT_EXPORT_DIR), else none. */
export function selectAuditExportSink(env: Env, processEnv: NodeJS.ProcessEnv = process.env): AuditExportSink | null {
  if (env.AUDIT_EXPORT_BUCKET !== undefined) {
    return new S3ObjectLockExportSink({
      bucket: env.AUDIT_EXPORT_BUCKET,
      region: env.STORAGE_REGION ?? "us-east-1",
      ...(env.STORAGE_ENDPOINT !== undefined ? { endpoint: env.STORAGE_ENDPOINT } : {}),
      forcePathStyle: env.STORAGE_FORCE_PATH_STYLE === "true",
      ...(env.STORAGE_ACCESS_KEY_ID !== undefined && env.STORAGE_SECRET_ACCESS_KEY !== undefined
        ? { credentials: { accessKeyId: env.STORAGE_ACCESS_KEY_ID, secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY } }
        : {}),
      sse: env.STORAGE_SSE ?? "aws:kms",
      ...(env.STORAGE_KMS_KEY_ID !== undefined ? { kmsKeyId: env.STORAGE_KMS_KEY_ID } : {}),
    });
  }
  const dir = processEnv.AUDIT_EXPORT_DIR;
  return dir !== undefined && dir !== "" ? new LocalDirExportSink(dir) : null;
}

export function createAuditExportHandler(context: QueueHandlerContext, deps: AuditExportHandlerDeps = {}): JobProcessor {
  const logger = new Logger("audit.export");
  const open = deps.connect ?? connect;
  const sinkFor = deps.sinkFor ?? ((env: Env) => selectAuditExportSink(env));
  const runExport = deps.runExport ?? ((client: ClientBase, sink: AuditExportSink) => runAuditExport(client, sink));

  return async (_client: ClientBase, _job: Job): Promise<void> => {
    const sink = sinkFor(context.env);
    if (sink === null) {
      if (context.env.NODE_ENV === "production") {
        incrementCounter("nominara_audit_export_failures_total", { reason: "no_sink_configured" });
        throw new UnrecoverableError("audit export has no sink: AUDIT_EXPORT_BUCKET is not set");
      }
      incrementCounter("nominara_audit_export_skipped_total", { reason: "no_sink_configured" });
      logger.warn({ event: "audit_export_skipped", reason: "no_sink_configured" });
      return;
    }

    const client = await open(withKeepalives(context.env.DATABASE_URL));
    const lockKey = globalQueueLockKey("audit.export");
    let held = false;
    const startedAt = Date.now();
    try {
      held = await tryAdvisorySessionLock(client, lockKey);
      if (!held) {
        incrementCounter("nominara_audit_export_yielded_total");
        logger.warn({ event: "audit_export_yielded" });
        return;
      }
      const location = await runExport(client, sink);
      incrementCounter("nominara_audit_export_runs_total");
      observeValue("nominara_audit_export_duration_seconds", (Date.now() - startedAt) / 1000);
      // The location names a bucket and a key (a date and a stamp), never a row; no workspace is named.
      logger.log({ event: "audit_export_written", location });
    } catch (error) {
      incrementCounter("nominara_audit_export_failures_total", { reason: "export_failed" });
      throw error;
    } finally {
      if (held && !(await releaseAdvisorySessionLock(client, lockKey))) {
        logger.error({ event: "audit_export_lock_not_held_at_release" });
      }
      await client.end();
    }
  };
}

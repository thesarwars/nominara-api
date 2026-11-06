import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { connect, withKeepalives } from "../../../db/client.js";
import { runDailyPurgeCycle } from "../../../workers/rollup/retention.js";
import { executePendingErasures } from "../../compliance/subject-request.js";
import { PurgeJournal } from "../../compliance/purge-journal.js";
import { S3JournalStore, writeComplianceExports } from "../../compliance/storage-adapters.js";
import { S3Adapter } from "../../storage/s3.adapter.js";
import { resolveStorageConfig } from "../../storage/storage-config.js";
import { deleteWorkspaceObjectsEverywhere } from "../../storage/workspace-purge.js";
import { incrementCounter } from "../../telemetry/metrics.js";
import { globalQueueLockKey, releaseAdvisorySessionLock, tryAdvisorySessionLock } from "../locks.js";
import type { QueueHandlerContext } from "../handlers.js";
import type { JobProcessor } from "../worker-factory.js";

// STORY-077 R4 / STORY-013 — `retention.purge`, the nightly tick for `runDailyPurgeCycle`.
//
// `data-model.md` §7 specifies the cascade and its timing: a project hard-deleted 30 days after its soft delete
// ("≤ 24 h"), a workspace hard-deleted at `deletion_execute_at`. `runDailyPurgeCycle` implements both, with tests, and
// nothing called it — a soft-deleted project was kept forever.
//
// *** THIS HANDLER DELETES CUSTOMER DATA, AND IT DOES NOTHING UNLESS `RETENTION_PURGE_ENABLED=true`. ***
//
// The spec says the purge is nightly. It does not authorise running it AUTOMATICALLY TODAY, and these are the reasons
// the flag defaults off rather than the schedule simply being on:
//
//   1. THERE IS NO OBJECT STORE. `hardDeleteProject` deletes S3 objects by prefix through a callback this handler cannot
//      supply — no object-storage client exists in the repo (`retention.ts`: "no object-storage client exists in this
//      repo yet (disclosed gap)"). Running it would delete the database rows and leave the raw captures they point at.
//   2. A WORKSPACE HARD DELETE CANNOT COMPLETE. It must "export the two surviving record sets first" to immutable
//      storage; with no exporter it throws and records a `purge_failures` row — every night, for every due workspace —
//      and `db:purge-check` blocks the release train on an unresolved failure past seven days.
//   3. §7'S NOTICE HALF IS UNBUILT. "A 14-day notice names exactly what will be purged and when ... and defers the first
//      purge to day 15" has no job (STORY-077 R1 is Open), and the data-model rule is that retention shortening must not
//      surprise a customer. Legal hold ("the purge job skips held subjects and reports them") is likewise not built.
//   4. THE PROJECT'S OWN PRECEDENT. `maintenance.partition` was deliberately scheduled for its non-destructive runway
//      half ONLY and kept every destructive step operator-invoked, because a reversible decision (a soft delete) must
//      not become irreversible faster than anyone can notice (`maintenance-partition.handler.ts`).
//
// No owner decision record authorises the automatic run. So the schedule row exists (the cadence is declared in one
// place, and the registrar boots it) and the flag is the switch. Turn it on only when 1-3 are closed.
//
// ⚠ EXACTLY "true" — a typo, "1" or "yes" leaves it OFF, and the env schema refuses those spellings at boot rather than
// guessing, because guessing wrong here deletes data (the same rule `OTP_DEV_LOG_CODES` follows for printing a secret).
//
// ⚠ WHEN OFF, THE HANDLER OPENS NO CONNECTION. A disabled purge that still dialled the owner role every night would be
// a privileged connection with nothing to show for it. It counts the skip, so "disabled" is a visible state.
//
// ⚠ THE OWNER CONNECTION, not the pooled runtime role, for the reason `retention.ts`'s header gives: the cross-tenant
// discovery is filtered to zero rows under RLS, and a workspace hard delete issues `ALTER TABLE ... DISABLE TRIGGER`,
// which needs table ownership. Direct (`DATABASE_URL`), never the pooler, because it holds a session advisory lock.
export function createRetentionPurgeHandler(context: QueueHandlerContext): JobProcessor {
  const tracer = trace.getTracer("nominara.retention");
  const logger = new Logger("retention.purge");

  return async (_client: ClientBase, _job: Job): Promise<void> => {
    if (context.env.RETENTION_PURGE_ENABLED !== "true") {
      incrementCounter("nominara_retention_purge_skipped_total", { reason: "disabled" });
      logger.warn("retention purge is DISABLED (RETENTION_PURGE_ENABLED is not \"true\"); nothing was deleted");
      return;
    }

    const client = await connect(withKeepalives(context.env.DATABASE_URL));
    const lockKey = globalQueueLockKey("retention.purge");
    let held = false;
    try {
      held = await tryAdvisorySessionLock(client, lockKey);
      if (!held) {
        incrementCounter("nominara_retention_purge_yielded_total");
        logger.warn("another replica holds the retention purge lock; yielding this tick");
        return;
      }

      // STORY-180 r5 / STORY-182: an erased workspace's stored files (reports, raw captures, crawl snapshots; every version) are deleted AFTER
      // its cascade commits. A PROJECT's raw objects are NOT deleted here: no writer keys raw objects by project (they are
      // `{env}/{ws}/YYYY/MM/{id}.json.gz`), so `deleteObjectPrefix` is deliberately left unwired and `hardDeleteProject` keeps recording the gap in
      // `purge_failures` (owner decision pending, see docs/plans/evidence/STORY-182-183.md). With object storage not configured the hook
      // is absent, so the files would be left: say so, loudly, every run.
      const storage = resolveStorageConfig(context.env);
      if (storage === null) logger.warn({ event: "report_objects_not_deleted", reason: "storage_unconfigured" });
      // STORY-111: with no object storage there is NO purge journal and NO compliance export. Said loudly every run; a workspace purge then
      // fails and is recorded (no exporter), and `db:purge-check` blocks the release train if that stays unresolved.
      if (storage === null) logger.warn({ event: "purge_journal_unavailable", reason: "storage_unconfigured" });
      const adapter = storage === null ? undefined : new S3Adapter(storage);
      const result = await runDailyPurgeCycle(client, {
        ...(storage !== null && adapter !== undefined
          ? {
              journal: new PurgeJournal(new S3JournalStore(adapter), storage.keyEnv),
              exporterFor: (workspaceId: string) => writeComplianceExports(adapter, storage.keyEnv, workspaceId),
              deleteWorkspaceObjects: async (workspaceId: string): Promise<void> => {
                await tracer.startActiveSpan("retention.workspace_objects_delete", async (span) => {
                  try {
                    const removed = await deleteWorkspaceObjectsEverywhere(adapter, storage.keyEnv, workspaceId);
                    incrementCounter("nominara_retention_workspace_objects_deleted_total", { outcome: "deleted" });
                    // The count and the workspace ID only: never a key.
                    logger.log({ event: "workspace_objects_deleted", workspace_id: workspaceId, versions_removed: removed });
                  } catch (error) {
                    span.setStatus({ code: SpanStatusCode.ERROR });
                    incrementCounter("nominara_retention_workspace_objects_deleted_total", { outcome: "failed" });
                    throw error;
                  } finally {
                    span.end();
                  }
                });
              },
            }
          : {}),
      });

      // Decision 68b: the nightly job also runs the erasures a legal hold had deferred, for holds that lapsed (the cycle above recorded them).
      const queued = await executePendingErasures(client);
      if (queued.executed + queued.blocked + queued.stillHeld > 0) logger.log({ event: "queued_erasures", ...queued });

      incrementCounter("nominara_retention_purge_runs_total");
      // Counts only: a project or workspace ID in a log line is a deletion record that belongs in the purge journal.
      logger.log(
        `retention purge: ${String(result.projectsPurged.length)} project(s) and ${String(result.workspacesPurged.length)} workspace(s) purged, ` +
          `${String(result.skipped.length)} skipped, ${String(result.held.length)} held, ${String(result.failed)} failed`,
      );
      // STORY-111: a held subject is REPORTED (a counter per hold is in the cycle), and any failure is an alert-worthy signal.
      if (result.failed > 0) logger.error({ event: "retention_purge_failures", failed: result.failed });
    } finally {
      if (held && !(await releaseAdvisorySessionLock(client, lockKey))) {
        logger.error("retention purge lock was not held at release — the lock key or the connection changed under us");
      }
      await client.end();
    }
  };
}

import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Job } from "bullmq";
import type { ClientBase, Pool } from "pg";
import { retentionExportCoverageSchema, retentionExportJobPayloadSchema, type RetentionExportCoverage } from "../../../../contracts/billing/retention-export.schema.js";
import { selectEmailSender } from "../../../modules/identity/email-sender.selector.js";
import { EmailSuppressedError, type EmailSender } from "../../../modules/identity/ports/email-sender.js";
import { uuidV7 } from "../../ids/uuidv7.js";
import { withExportLock } from "../../../workers/rollup/retention.js";
import { attributionPurgeList, rawPurgeList, rollupPurgeList } from "../../billing/retention-shortening.js";
import { buildRetentionExport, type BuildProject } from "../../billing/retention-export/build.js";
import { retentionExportDownloadUrl, retentionExportRelativeKey } from "../../billing/retention-export/links.js";
import { retentionExportReadyEmail } from "../../billing/retention-export/ready-email.js";
import { readExportScope, type ExportScope } from "../../billing/retention-export/scope.js";
import { ZipLimitError } from "../../billing/retention-export/zip.js";
import { S3Adapter } from "../../storage/s3.adapter.js";
import { resolveStorageConfig } from "../../storage/storage-config.js";
import { TenantObjectStore, type BoundObjectStore } from "../../storage/tenant-object-store.js";
import { unconfiguredStoragePort } from "../../storage/unconfigured-port.js";
import { incrementCounter, observeValue } from "../../telemetry/metrics.js";
import type { QueueHandlerContext } from "../handlers.js";
import { PHASES_DONE, phasedProcessor, type JobProcessor } from "../worker-factory.js";

// STORY-185 / owner decision 100(a),(c) - `billing.retention_export`: builds the full-data export of everything a pending retention purge removes.
//
// A SIGNED TENANT job, PHASED (ADR-0003). The payload is `.strict()` and carries ids only: the scope (what is purged, from when) is read from the
// database inside the tenant context, never from the request.
//   prepare  ONE short tenant transaction: lock the export row; end the job when it is already finished (ready and mailed, failed); re-read the
//            scope (the deferral may have ended: then the export FAILS `deferral_ended`, there is nothing left to offer); mark it `building`; list
//            the projects from the notice's own purge-list builders; bind the object store (no I/O); read the requester's address.
//   run      NO transaction held across an await on the store or the provider. The reads are short tenant transactions through `step`, one page
//            each (build.ts), under each project's export lock (EC-40) on a dedicated idle connection; the raw objects are fetched between pages;
//            the zip is uploaded with no transaction open; ONLY THEN `step` commits `ready` (so the link in the email cannot 404), and the email
//            is sent, and `step` commits `emailed_at`.
//   commit   metrics and the log line.
// A retry after the file is ready but before it was mailed goes straight to the email (prepare sees `ready`, `emailed_at` null), never rebuilds.
// IDEMPOTENT under at-least-once delivery: every delivery uploads under its OWN run id; the `ready` write is conditional on `building`, so one
// delivery wins and a loser neither overwrites the key nor sends a second email (its object is an orphan inside the tenant prefix, as in
// ADR-0003). The email carries a provider idempotency key derived from the export id.
//
// 0 CREDITS: nothing here touches the wallet, a reservation, a quota or the report-artifact tables.
// LAST ATTEMPT: `recover` marks the row `failed` (a stable code) so the owner sees it and can request again; the error still reaches the queue (DLQ).
// A zip that would need ZIP64 is a stable `zip_limit` failure at once (retrying cannot change it).

const tracer = trace.getTracer("nominara.billing-retention-export");

/** BullMQ increments `attemptsMade` when an attempt fails, so during attempt N it is N-1. An unknown `attempts` is "not known to be final". */
function isFinalAttempt(job: Pick<Job, "attemptsMade" | "opts">): boolean {
  const attempts = job.opts?.attempts;
  return attempts !== undefined && (job.attemptsMade ?? 0) + 1 >= attempts;
}

type Outcome = "ready" | "emailed" | "lost" | "failed_zip_limit" | "suppressed" | "no_recipient";

interface BuildPrepared {
  readonly kind: "build";
  readonly exportId: string;
  readonly workspaceId: string;
  readonly scope: ExportScope;
  readonly projects: readonly BuildProject[];
  readonly bound: BoundObjectStore;
  readonly to: string | null;
  readonly expiresAt: Date;
}
interface EmailPrepared {
  readonly kind: "email";
  readonly exportId: string;
  readonly workspaceId: string;
  readonly to: string | null;
  readonly expiresAt: Date;
  readonly coverage: RetentionExportCoverage;
}
type Prepared = BuildPrepared | EmailPrepared;

export interface RetentionExportDeps {
  readonly sender?: EmailSender;
  readonly store?: TenantObjectStore;
  /** The API's public origin for the link in the email. Defaults to OAUTH_REDIRECT_BASE_URL. */
  readonly apiBaseUrl?: string;
  readonly now?: () => Date;
}

async function lockedProject<T>(pool: Pool, projectId: string, fn: () => Promise<T>): Promise<T> {
  // A dedicated connection, idle (not in a transaction) while `fn` awaits the store: a session advisory lock belongs to a connection.
  const client = await pool.connect();
  try {
    return await withExportLock(client, projectId, fn);
  } finally {
    client.release();
  }
}

export function createBillingRetentionExportHandler(context: QueueHandlerContext, deps: RetentionExportDeps = {}): JobProcessor {
  const logger = new Logger("billing.retention_export");
  let sender = deps.sender;
  const senderFor = (): EmailSender => (sender ??= selectEmailSender());
  let store = deps.store;
  const storeFor = (): TenantObjectStore => {
    if (store === undefined) {
      const config = resolveStorageConfig(context.env);
      store = new TenantObjectStore(config === null ? unconfiguredStoragePort() : new S3Adapter(config), config?.keyEnv ?? context.env.NODE_ENV);
    }
    return store;
  };
  const now = deps.now ?? ((): Date => new Date());
  const baseUrl = (): string => deps.apiBaseUrl ?? context.env.OAUTH_REDIRECT_BASE_URL;

  const requesterEmail = async (tx: ClientBase, userId: string | null): Promise<string | null> => {
    if (userId === null) return null;
    const r = await tx.query<{ email: string }>("SELECT email::text AS email FROM users WHERE id = $1 AND deleted_at IS NULL", [userId]);
    return r.rows[0]?.email ?? null;
  };

  const markFailed = async (tx: ClientBase, exportId: string, code: string): Promise<void> => {
    await tx.query("UPDATE retention_exports SET status = 'failed', error_code = $2, updated_at = now() WHERE id = $1 AND workspace_id = app.current_workspace() AND status IN ('requested', 'building')", [exportId, code]);
  };

  return phasedProcessor<Prepared, Outcome>({
    async prepare(tx: ClientBase, job: Job) {
      const payload = retentionExportJobPayloadSchema.parse((job.data as { payload: unknown }).payload);
      const found = await tx.query<{ status: string; requested_by: string | null; expires_at: Date; emailed_at: Date | null; coverage: unknown }>(
        "SELECT status, requested_by, expires_at, emailed_at, coverage FROM retention_exports WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
        [payload.exportId, payload.workspaceId],
      );
      const row = found.rows[0];
      if (row === undefined || row.status === "failed" || (row.status === "ready" && row.emailed_at !== null)) {
        incrementCounter("nominara_billing_retention_export_jobs_total", { outcome: "already_done" });
        return PHASES_DONE;
      }
      const to = await requesterEmail(tx, row.requested_by);
      if (row.status === "ready") {
        // Built and committed, never mailed (a retry after the email failed): no rebuild.
        return { kind: "email", exportId: payload.exportId, workspaceId: payload.workspaceId, to, expiresAt: row.expires_at, coverage: retentionExportCoverageSchema.parse(row.coverage) };
      }
      const scope = await readExportScope(tx, payload.workspaceId, now());
      if (scope === null) {
        await markFailed(tx, payload.exportId, "deferral_ended");
        incrementCounter("nominara_billing_retention_export_jobs_total", { outcome: "deferral_ended" });
        logger.warn({ event: "billing.retention_export.deferral_ended", workspace_id: payload.workspaceId });
        return PHASES_DONE;
      }
      await tx.query("UPDATE retention_exports SET status = 'building', updated_at = now() WHERE id = $1 AND status IN ('requested', 'building')", [payload.exportId]);
      // The notice's own purge-list builders decide which projects have something to export, so the export names the projects the notice does.
      const lists = [
        ...(scope.raw === null ? [] : await rawPurgeList(tx, payload.workspaceId, scope.raw.cutoff)),
        ...(scope.rollups === null ? [] : await rollupPurgeList(tx, payload.workspaceId, scope.rollups.cutoff)),
        ...(scope.rollups === null ? [] : await attributionPurgeList(tx, payload.workspaceId, scope.rollups.cutoff)),
      ];
      const byId = new Map<string, BuildProject>();
      for (const line of lists) byId.set(line.projectId, { projectId: line.projectId, name: line.name });
      const projects = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name) || a.projectId.localeCompare(b.projectId));
      return { kind: "build", exportId: payload.exportId, workspaceId: payload.workspaceId, scope, projects, bound: storeFor().bind(), to, expiresAt: row.expires_at };
    },

    async run(prepared: Prepared, _job: Job, step) {
      const tenantStep = step ?? (async () => { throw new Error("billing.retention_export needs the tenant step"); });
      return await tracer.startActiveSpan("billing.retention_export.run", async (span) => {
        span.setAttributes({ "nominara.workspace_id": prepared.workspaceId, "nominara.retention_export.kind": prepared.kind });
        try {
          let coverage: RetentionExportCoverage;
          if (prepared.kind === "build") {
            const started = Date.now();
            let built;
            try {
              built = await buildRetentionExport({
                workspaceId: prepared.workspaceId,
                scope: prepared.scope,
                projects: prepared.projects,
                step: tenantStep,
                lockProject: (projectId, fn) => lockedProject(context.pool, projectId, fn),
                readRaw: (key) => prepared.bound.getStored("raw", key),
                now: now(),
              });
            } catch (error) {
              if (error instanceof ZipLimitError) {
                span.setAttribute("nominara.retention_export.zip_limit", true);
                return "failed_zip_limit" as const;
              }
              throw error;
            }
            const stored = await prepared.bound.put("reports", retentionExportRelativeKey(prepared.exportId, uuidV7()), built.zip, { contentType: "application/zip" });
            // The row says `ready` only now that the object is stored; the email below is sent only after that commit.
            const won = await tenantStep(async (tx) => {
              const r = await tx.query(
                `UPDATE retention_exports SET status = 'ready', object_key = $2, coverage = $3::jsonb, ready_at = now(), updated_at = now()
                  WHERE id = $1 AND workspace_id = app.current_workspace() AND status = 'building'`,
                [prepared.exportId, stored, JSON.stringify(built.coverage)],
              );
              return (r.rowCount ?? 0) === 1;
            });
            span.setAttributes({ "nominara.retention_export.bytes": built.zip.length, "nominara.retention_export.projects": built.coverage.projects.length, "nominara.retention_export.complete": built.coverage.complete });
            observeValue("nominara_billing_retention_export_zip_bytes", built.zip.length);
            observeValue("nominara_billing_retention_export_build_duration_ms", Date.now() - started);
            if (!won) return "lost" as const;
            coverage = built.coverage;
          } else {
            coverage = prepared.coverage;
          }

          if (prepared.to === null) return "no_recipient" as const;
          try {
            await senderFor().send(retentionExportReadyEmail(prepared.to, retentionExportDownloadUrl(baseUrl(), prepared.exportId), prepared.expiresAt, coverage, `retention-export/${prepared.exportId}`));
          } catch (error) {
            if (error instanceof EmailSuppressedError) return "suppressed" as const;
            incrementCounter("nominara_billing_retention_export_failed_total", { reason: "email_failed" });
            throw error;
          }
          await tenantStep((tx) => tx.query("UPDATE retention_exports SET emailed_at = now() WHERE id = $1 AND workspace_id = app.current_workspace() AND emailed_at IS NULL", [prepared.exportId]));
          return "emailed" as const;
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          // Ids and the error class only: never a key, an address, an answer or a provider's text.
          logger.warn({ event: "billing.retention_export.run_failed", workspace_id: prepared.workspaceId, error: error instanceof Error ? error.name : "unknown" });
          throw error;
        } finally {
          span.end();
        }
      });
    },

    async commit(tx: ClientBase, prepared: Prepared, outcome: Outcome) {
      if (outcome === "failed_zip_limit") await markFailed(tx, prepared.exportId, "zip_limit");
      incrementCounter("nominara_billing_retention_export_jobs_total", { outcome });
      logger.log({ event: "billing.retention_export.done", workspace_id: prepared.workspaceId, outcome });
    },

    async recover(tx: ClientBase, job: Job, failure) {
      if (!isFinalAttempt(job)) return false;
      const parsed = retentionExportJobPayloadSchema.safeParse((job.data as { payload: unknown }).payload);
      if (!parsed.success) return false;
      // Built but never mailed stays `ready`: the in-app link works. Anything before that is a failed export the owner can request again.
      await markFailed(tx, parsed.data.exportId, failure.phase === "prepare" ? "prepare_failed" : "build_failed");
      incrementCounter("nominara_billing_retention_export_failed_total", { reason: "final_attempt" });
      return false;
    },
  });
}

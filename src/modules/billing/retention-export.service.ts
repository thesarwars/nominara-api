import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase } from "pg";
import {
  RETENTION_EXPORT_MAX_LIFETIME_DAYS,
  RETENTION_EXPORT_URL_SECONDS,
  retentionExportCoverageSchema,
  type RetentionExport,
  type RetentionExportParams,
  type RetentionExportStatus,
  type RetentionExportView,
} from "../../../contracts/billing/retention-export.schema.js";
import { afterTransaction } from "../../api/after-transaction.js";
import { DegradedError, NotFoundError, PreconditionUnmetError } from "../../api/errors/domain-errors.js";
import { readExportScope, sameScope, scopeSnapshot, type ExportScope } from "../../lib/billing/retention-export/scope.js";
import { retentionExportDownloadUrl, retentionExportFilename } from "../../lib/billing/retention-export/links.js";
import { QueueProducer } from "../../lib/queue/queue-producer.js";
import { TenantObjectStore } from "../../lib/storage/tenant-object-store.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import { afterCommit, currentTenantStore } from "../../tenancy/tenant-context.js";

// STORY-185 / owner decision 100(a),(c) - the full-data export before a retention purge. The contract (contracts/billing/retention-export.schema.ts)
// says what it holds; the job (lib/queue/handlers/billing-retention-export.handler.ts) builds it. This service records the request, answers the view
// and mints the download.
//
// OWN GUARD, NOT THE REPORT EXPORT'S. It is available only while a retention-shortening deferral is pending (`readExportScope`), and it is NOT gated by
// the new plan's `exports.*` entitlements, the `pdf_exports` quota or `export:data`. It touches no wallet, reservation or quota: 0 credits by
// construction (there is no code path here that reaches the credit ledger). The permission is `billing:write` (owner and admin).
//
// ONE IN FLIGHT. A second request while one is requested or building answers THAT row (the partial unique index is the guarantee; the read is the
// fast path) and re-offers its job (idempotent by key), so an enqueue that failed after the first request's commit is retried by asking again. A
// ready, unexpired export is answered as it is: what it covers is data older than a fixed cutoff, which only shrinks, so it stays complete.
// A failed one is not reused: a new request starts a new export.
//
// NO NETWORK CALL IN THE REQUEST (KAD-06): the request enqueues after commit; the download mints a presign (a local signature) after the
// request's transaction has ended (ADR-0003, `afterTransaction`), fresh on EVERY fetch.

const tracer = trace.getTracer("nominara-api");
const logger = new Logger("RetentionExport");

/** DI token: the API's public origin for the download link. */
export const RETENTION_EXPORT_BASE_URL = "RETENTION_EXPORT_BASE_URL";

const DAY_MS = 86_400_000;

interface Row {
  id: string;
  status: string;
  created_at: Date;
  expires_at: Date;
  ready_at: Date | null;
  coverage: unknown;
  error_code: string | null;
  object_key: string | null;
  object_purged_at: Date | null;
  scope: unknown;
}

const COLUMNS = "id, status, created_at, expires_at, ready_at, coverage, error_code, object_key, object_purged_at, scope";

@Injectable()
export class RetentionExportService {
  constructor(
    private readonly objects: TenantObjectStore,
    @Inject(RETENTION_EXPORT_BASE_URL) private readonly baseUrl: string,
    @Optional() @Inject(QueueProducer) private readonly queues?: Pick<QueueProducer, "enqueueTenantJob">,
  ) {}

  /** `GET /v1/billing/retention-export`. */
  async view(): Promise<RetentionExportView> {
    return await this.traced("billing.retention_export.view", async () => {
      const { client, workspaceId } = this.tenant();
      const scope = await readExportScope(client, workspaceId, new Date());
      const latest = await this.latest(client, workspaceId);
      return { available: scope !== null, purge_not_before: scope?.purgeNotBefore.toISOString() ?? null, export: latest === undefined ? null : this.render(latest, scope) };
    });
  }

  /** `POST /v1/billing/retention-export` (202). */
  async request(): Promise<RetentionExport> {
    return await this.traced("billing.retention_export.request", async () => {
      const { client, workspaceId, actorId } = this.tenant();
      const now = new Date();
      const scope = await readExportScope(client, workspaceId, now);
      if (scope === null) {
        incrementCounter("nominara_billing_retention_export_requests_total", { outcome: "not_available" });
        throw new PreconditionUnmetError({ message: "no retention-shortening purge is pending, so there is nothing to export" });
      }

      // An in-flight row whose link date has passed can never finish usefully: fail it NOW, in this transaction, so it cannot hold the one in-flight slot or be answered.
      await client.query("UPDATE retention_exports SET status = 'failed', error_code = 'expired', updated_at = now() WHERE workspace_id = $1 AND status IN ('requested', 'building') AND expires_at <= now()", [workspaceId]);

      const current = await this.latest(client, workspaceId);
      const live = current !== undefined && current.expires_at.getTime() > now.getTime();
      // REUSE ONLY FOR THE SAME SCOPE (audit major 1): a second shortening inside the deferral moves the cutoffs, and an export built for the earlier ones is
      // not complete. A row with no stored scope (legacy) never matches.
      if (current !== undefined && live && current.status === "ready" && sameScope(current.scope, scope)) {
        incrementCounter("nominara_billing_retention_export_requests_total", { outcome: "already_ready" });
        return this.render(current, scope);
      }
      if (current !== undefined && live && (current.status === "requested" || current.status === "building")) {
        if (sameScope(current.scope, scope)) {
          incrementCounter("nominara_billing_retention_export_requests_total", { outcome: "in_flight" });
          this.enqueueAfterCommit(workspaceId, current.id);
          return this.render(current, scope);
        }
        // Built for an earlier scope: stop it (its commit is conditional on `building`, so it can no longer become ready) and start over.
        await client.query("UPDATE retention_exports SET status = 'failed', error_code = 'superseded', updated_at = now() WHERE id = $1 AND workspace_id = $2 AND status IN ('requested', 'building')", [current.id, workspaceId]);
        incrementCounter("nominara_billing_retention_export_requests_total", { outcome: "superseded_in_flight" });
      }

      const expiresAt = new Date(Math.min(scope.purgeNotBefore.getTime(), now.getTime() + RETENTION_EXPORT_MAX_LIFETIME_DAYS * DAY_MS));
      const id = uuidV7();
      const inserted = await client.query<Row>(
        // requested_by is the user when the actor is one; null otherwise (the foreign key never fails the request).
        `INSERT INTO retention_exports (id, workspace_id, requested_by, status, expires_at, scope)
         VALUES ($1, $2, (SELECT id FROM users WHERE id = $3), 'requested', $4, $5::jsonb)
         ON CONFLICT (workspace_id) WHERE status IN ('requested', 'building') DO NOTHING
         RETURNING ${COLUMNS}`,
        [id, workspaceId, actorId, expiresAt.toISOString(), JSON.stringify(scopeSnapshot(scope))],
      );
      const row = inserted.rows[0] ?? (await this.latest(client, workspaceId));
      if (row === undefined) throw new Error("retention export row neither inserted nor found");
      if (inserted.rows[0] === undefined) {
        // A concurrent request won the single in-flight slot: answer it.
        incrementCounter("nominara_billing_retention_export_requests_total", { outcome: "in_flight" });
      } else {
        incrementCounter("nominara_billing_retention_export_requests_total", { outcome: "requested" });
        logger.log({ message: "retention export requested", workspace_id: workspaceId });
      }
      this.enqueueAfterCommit(workspaceId, row.id);
      return this.render(row, scope);
    });
  }

  /**
   * `GET /v1/billing/retention-export/{id}/download`: the lookup on the ambient request client, then (after the request's transaction) a FRESH
   * 15-minute presign of the stored key. A row of another workspace, an unknown id and an expired link are one neutral 404; a build still under way
   * (or failed) is 503 `degraded`, never a presign.
   */
  async resolve(params: RetentionExportParams, setLocation: (url: string) => void): Promise<void> {
    const started = Date.now();
    const { client, workspaceId } = this.tenant();
    const bound = this.objects.bind();
    let outcome = "error";
    let deferred = false;
    try {
      const found = await client.query<Row>(`SELECT ${COLUMNS} FROM retention_exports WHERE id = $1 AND workspace_id = app.current_workspace()`, [params.id]);
      const row = found.rows[0];
      // An expired export, and one whose object the cleanup deleted (whatever its date says), is the same neutral 404.
      if (row === undefined || row.expires_at.getTime() <= Date.now() || row.object_purged_at !== null) throw new NotFoundError({ message: "no such export" });
      if (row.status !== "ready" || row.object_key === null) throw new DegradedError({ message: "the export file is not available" });
      const key = row.object_key;
      const readyAt = row.ready_at ?? row.created_at;
      // Never longer than the export itself has left (and never longer than a download's 15 minutes).
      const lifetime = Math.max(1, Math.min(RETENTION_EXPORT_URL_SECONDS, Math.floor((row.expires_at.getTime() - Date.now()) / 1000)));
      const registered = afterTransaction(async () => {
        let after = "error";
        try {
          setLocation(await bound.presignGetStored("reports", key, { expiresInSeconds: lifetime, downloadFilename: retentionExportFilename(readyAt) }));
          after = "redirected";
        } finally {
          incrementCounter("nominara_billing_retention_export_downloads_total", { outcome: after });
          // The workspace ID and the outcome: never the export id, the key or the URL (a presigned URL is a credential).
          logger.log({ span: "billing.retention_export.download", workspace_id: workspaceId, outcome: after, duration_ms: Date.now() - started });
        }
      });
      // Fail closed: with no request transaction to wait for, nothing would ever set the Location.
      if (!registered) throw new Error("RetentionExportService.resolve requires a request transaction to run after");
      deferred = true;
    } catch (error) {
      outcome = error instanceof NotFoundError ? "refused" : error instanceof DegradedError ? "unavailable" : "error";
      throw error;
    } finally {
      if (!deferred) {
        incrementCounter("nominara_billing_retention_export_downloads_total", { outcome });
        logger.log({ span: "billing.retention_export.download", workspace_id: workspaceId, outcome, duration_ms: Date.now() - started });
      }
    }
  }

  private async latest(client: ClientBase, workspaceId: string): Promise<Row | undefined> {
    const r = await client.query<Row>(`SELECT ${COLUMNS} FROM retention_exports WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [workspaceId]);
    return r.rows[0];
  }

  /** `scope` is the CURRENT scope (null when no deferral is pending). A ready, live export built for another scope reads `superseded`. */
  private render(row: Row, scope: ExportScope | null): RetentionExport {
    const expired = row.expires_at.getTime() <= Date.now();
    let status: RetentionExportStatus = (expired || row.object_purged_at !== null) && row.status !== "failed" ? "expired" : (row.status as RetentionExportStatus);
    if (status === "ready" && scope !== null && !sameScope(row.scope, scope)) status = "superseded";
    return {
      id: row.id,
      status,
      requested_at: row.created_at.toISOString(),
      expires_at: row.expires_at.toISOString(),
      ready_at: row.ready_at?.toISOString() ?? null,
      coverage: row.coverage === null ? null : retentionExportCoverageSchema.parse(row.coverage),
      download_url: status === "ready" ? retentionExportDownloadUrl(this.baseUrl, row.id) : null,
      error_code: row.error_code,
    };
  }

  /** After the commit, never inside it: a job enqueued from inside the transaction could run before the row is visible. A failed enqueue is counted and logged; asking again re-offers it. */
  private enqueueAfterCommit(workspaceId: string, exportId: string): void {
    afterCommit(() => {
      const queues = this.queues;
      if (queues === undefined) {
        logger.warn({ message: "no queue producer: the retention export is recorded and not built", workspace_id: workspaceId });
        return;
      }
      void queues
        .enqueueTenantJob("billing.retention_export", workspaceId, { exportId }, { idempotencyKey: `retexp:${workspaceId}:${exportId}` })
        .then(() => incrementCounter("nominara_billing_retention_export_enqueued_total"))
        .catch((error: unknown) => {
          incrementCounter("nominara_billing_retention_export_failed_total", { reason: "enqueue_failed" });
          logger.error({ message: "retention export recorded but its job could not be enqueued", workspace_id: workspaceId, error: error instanceof Error ? error.name : "unknown" });
        });
    });
  }

  private tenant(): { client: ClientBase; workspaceId: string; actorId: string } {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("RetentionExportService requires an active tenant context");
    return { client: store.client, workspaceId: store.context.workspaceId, actorId: store.context.actorId };
  }

  private async traced<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return await tracer.startActiveSpan(name, async (span) => {
      try {
        return await fn();
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}

import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Pool } from "pg";
import { EXPORT_DOWNLOAD_URL_SECONDS, type ExportDownloadParams } from "../../../contracts/reports/index.js";
import { afterTransaction } from "../../api/after-transaction.js";
import { DegradedError, NotFoundError } from "../../api/errors/domain-errors.js";
import { API_VERSION_PREFIX } from "../../api/configure-app.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import { reportFileName } from "../../lib/reports/artifact-filename.js";
import { isStoredObjectKey } from "../../lib/reports/artifact-key.js";
import { TenantObjectStore } from "../../lib/storage/tenant-object-store.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { currentTenantStore, withTenantContext } from "../../tenancy/tenant-context.js";

// STORY-180 AC2 + owner decision 54 (2) - GET /v1/exports/{id}/download.
//
// The on-screen download. `ExportResponse.download_url` points HERE, not at the bucket: this route is read when the user clicks, looks
// the artifact up in the caller's workspace, and answers a redirect to a presign of the STORED key (`presignGetStored`) that lives 15
// minutes and is minted fresh on EVERY fetch, with a Content-Disposition naming the file. Since owner decision 60 (c) the export does
// not answer until the file is stored, so a stored file is the normal case; a row whose key is still a marker (pending, failed or
// purged) is answered 503 `degraded`, never presigned.
//
// Authenticated (the ordinary session and export:data). The LOOKUP runs on the AMBIENT request client, the transaction
// TenantContextInterceptor already holds: the service checks out no pooled connection for it. The PRESIGN (the SDK may resolve role
// credentials over HTTP) and the served-download count run AFTER that transaction has committed and released its connection
// (afterTransaction, ADR-0003): the count takes its own short tenant transaction. The workspace comes from the session, never the
// path. A manager scoped to some projects reaches only an export whose projects are ALL in their scope (the route carries
// @ScopedByQuery, so this predicate is the scope check). One neutral 404 for an unknown, expired or other-workspace id.

const logger = new Logger("ExportDownload");

/** DI token: the API's public origin (OAUTH_REDIRECT_BASE_URL), provided by ReportsModule; worker contexts pass `env.OAUTH_REDIRECT_BASE_URL` directly. */
export const EXPORT_PUBLIC_BASE_URL = "EXPORT_PUBLIC_BASE_URL";

/** The absolute URL the export response carries: this route on the API's public origin. */
export function exportDownloadUrl(apiBaseUrl: string, exportId: string): string {
  return new URL(`/${API_VERSION_PREFIX}/exports/${exportId}/download`, apiBaseUrl).href;
}

@Injectable()
export class ExportDownloadService {
  constructor(
    private readonly objects: TenantObjectStore,
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly resolver: EntitlementResolver,
  ) {}

  /**
   * Looks the artifact up on the ambient request client, then registers the presign to run after the request transaction.
   * `setLocation` receives the presigned URL once it exists; the response is not produced before it has.
   */
  async resolve(params: ExportDownloadParams, setLocation: (url: string) => void): Promise<void> {
    const started = Date.now();
    const store = currentTenantStore();
    if (store === undefined) throw new Error("ExportDownloadService requires an active tenant context");
    const { context, client: tx } = store;
    const bound = this.objects.bind();
    let outcome = "error";
    let deferred = false;
    try {
      const found = await tx.query<{ object_key: string; format: string; period_end: string; hide_brand: boolean | null }>(
        `SELECT object_key, format, period_end::text AS period_end,
                (SELECT t.hide_nominara_brand FROM brand_themes t
                  WHERE t.id = (SELECT r.theme_id FROM scheduled_reports r WHERE r.id = report_artifacts.scheduled_report_id) OR t.is_default
                  ORDER BY (t.id = (SELECT r.theme_id FROM scheduled_reports r WHERE r.id = report_artifacts.scheduled_report_id)) DESC NULLS LAST, t.is_default DESC, t.created_at, t.id LIMIT 1) AS hide_brand
           FROM report_artifacts
          WHERE id = $1 AND workspace_id = app.current_workspace() AND expires_at > now()
            AND (cardinality(app.current_scope_projects()) = 0 OR project_ids <@ app.current_scope_projects())`,
        [params.id],
      );
      const row = found.rows[0];
      if (row === undefined) throw new NotFoundError({ message: "no such export" });
      if (!isStoredObjectKey(row.object_key)) throw new DegradedError({ message: "the export file is not available" });
      // STORY-097 AC4: the file name carries no platform name once the brand is removed (entitlement held NOW and the theme's switch set).
      const entitlements = await this.resolver.resolveForWorkspace(context.workspaceId);
      const showBrand = !(row.hide_brand === true && entitlements.entitlements["whitelabel.remove_branding"]?.value === true);
      // No transaction and no pooled connection is held from here on: the presign and the count run once the request's transaction ended.
      const registered = afterTransaction(async () => {
        let after = "error";
        try {
          const url = await bound.presignGetStored("reports", row.object_key, {
            expiresInSeconds: EXPORT_DOWNLOAD_URL_SECONDS,
            downloadFilename: reportFileName(showBrand, row.period_end, row.format),
          });
          setLocation(url);
          after = "redirected";
          // Counted only once the download has been served (not when the presign was refused). A failed count never withholds the file.
          await this.countServed(context, params.id);
        } finally {
          incrementCounter("nominara_reports_downloads_total", { outcome: after });
          // Workspace ID and outcome only: never the id of the file, the key or the URL.
          logger.log({ span: "reports.export.download", workspace_id: context.workspaceId, outcome: after, duration_ms: Date.now() - started });
        }
      });
      // Fail closed: with no request transaction to wait for, nothing would ever set the Location.
      if (!registered) throw new Error("ExportDownloadService requires a request transaction to run after");
      deferred = true;
    } catch (error) {
      outcome = error instanceof NotFoundError ? "refused" : error instanceof DegradedError ? "unavailable" : error instanceof Error ? error.name : "error";
      throw error;
    } finally {
      if (!deferred) {
        incrementCounter("nominara_reports_downloads_total", { outcome });
        logger.log({ span: "reports.export.download", workspace_id: context.workspaceId, outcome, duration_ms: Date.now() - started });
      }
    }
  }

  private async countServed(context: { workspaceId: string; actorId: string; scopeProjectIds?: readonly string[] }, id: string): Promise<void> {
    try {
      const client = await this.pool.connect();
      try {
        await withTenantContext(client, context, (tx) =>
          tx.query("UPDATE report_artifacts SET download_count = download_count + 1 WHERE id = $1 AND workspace_id = app.current_workspace()", [id]),
        );
      } finally {
        client.release();
      }
    } catch {
      incrementCounter("nominara_reports_downloads_total", { outcome: "count_failed" });
      logger.error({ span: "reports.export.download", workspace_id: context.workspaceId, outcome: "count_failed" });
    }
  }
}

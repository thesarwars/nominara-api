import { Injectable, Logger } from "@nestjs/common";
import { EXPORT_DOWNLOAD_URL_SECONDS, type ExportDownloadParams } from "../../../contracts/reports/index.js";
import { ConflictError, NotFoundError } from "../../api/errors/domain-errors.js";
import { API_VERSION_PREFIX } from "../../api/configure-app.js";
import { TenantObjectStore } from "../../lib/storage/tenant-object-store.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";

// STORY-180 AC2 + owner decision 54 (2) - GET /v1/exports/{id}/download.
//
// The on-screen download. `ExportResponse.download_url` points HERE, not at the bucket: the file is uploaded after the export's
// transaction commits, so a presign minted inside the export response could be clicked before the object exists, and a replayed
// response (Idempotency-Key) would carry a URL that has expired. This route is read when the user clicks: it looks the artifact up in
// the caller's workspace, refuses while the stored key is still `pending:` (409), and otherwise answers a redirect to a presign of the
// STORED key (`presignGetStored`) that lives 15 minutes and is minted fresh on EVERY fetch, with a Content-Disposition naming the file.
//
// Authenticated (the ordinary session and export:data). Both statements (the lookup, the served-download count) run on the AMBIENT request
// client, the transaction TenantContextInterceptor already holds: the service checks out no pooled connection of its own (a second
// checkout per request while the first is held exhausts the pool under concurrent clicks and stalls the whole API). The presign is a
// local signature, the same position the export path's readiness probe takes (ADR-0003 question, tracked in the evidence file): it
// does happen inside the request transaction. The workspace comes from the session, never the path. A manager scoped to some projects
// reaches only an export whose projects are ALL in their scope (the route carries @ScopedByQuery, so this predicate is the scope
// check). One neutral 404 for an unknown, expired or other-workspace id.

const logger = new Logger("ExportDownload");

/** DI token: the API's public origin (OAUTH_REDIRECT_BASE_URL), provided by ReportsModule; worker contexts pass `env.OAUTH_REDIRECT_BASE_URL` directly. */
export const EXPORT_PUBLIC_BASE_URL = "EXPORT_PUBLIC_BASE_URL";

/** The absolute URL the export response carries: this route on the API's public origin. */
export function exportDownloadUrl(apiBaseUrl: string, exportId: string): string {
  return new URL(`/${API_VERSION_PREFIX}/exports/${exportId}/download`, apiBaseUrl).href;
}

@Injectable()
export class ExportDownloadService {
  constructor(private readonly objects: TenantObjectStore) {}

  async resolve(params: ExportDownloadParams): Promise<{ url: string }> {
    const started = Date.now();
    const store = currentTenantStore();
    if (store === undefined) throw new Error("ExportDownloadService requires an active tenant context");
    const { context, client: tx } = store;
    const bound = this.objects.bind();
    let outcome = "error";
    try {
      const found = await tx.query<{ object_key: string; format: string; period_end: string }>(
        `SELECT object_key, format, period_end::text AS period_end FROM report_artifacts
          WHERE id = $1 AND workspace_id = $2 AND expires_at > now()
            AND (cardinality(app.current_scope_projects()) = 0 OR project_ids <@ app.current_scope_projects())`,
        [params.id, context.workspaceId],
      );
      const row = found.rows[0];
      if (row === undefined) throw new NotFoundError({ message: "no such export" });
      if (row.object_key.startsWith("pending:")) throw new ConflictError({ message: "the export file is not ready yet; try again shortly" });
      const url = await bound.presignGetStored("reports", row.object_key, {
        expiresInSeconds: EXPORT_DOWNLOAD_URL_SECONDS,
        downloadFilename: `nominara-report-${row.period_end}.${row.format}`,
      });
      // Counted only once the download has been served (not while pending, not when the presign was refused).
      // A failed count must not poison the request transaction, so it runs under a savepoint and is rolled back to on failure.
      await tx.query("SAVEPOINT export_download_count");
      try {
        await tx.query("UPDATE report_artifacts SET download_count = download_count + 1 WHERE id = $1 AND workspace_id = $2", [params.id, context.workspaceId]);
        await tx.query("RELEASE SAVEPOINT export_download_count");
      } catch {
        await tx.query("ROLLBACK TO SAVEPOINT export_download_count");
        incrementCounter("nominara_reports_downloads_total", { outcome: "count_failed" });
        logger.error({ span: "reports.export.download", workspace_id: context.workspaceId, outcome: "count_failed" });
      }
      outcome = "redirected";
      return { url };
    } catch (error) {
      outcome = error instanceof NotFoundError ? "refused" : error instanceof ConflictError ? "not_ready" : error instanceof Error ? error.name : "error";
      throw error;
    } finally {
      incrementCounter("nominara_reports_downloads_total", { outcome });
      // Workspace ID and outcome only: never the id of the file, the key or the URL.
      logger.log({ span: "reports.export.download", workspace_id: context.workspaceId, outcome, duration_ms: Date.now() - started });
    }
  }
}

import { Injectable, Logger } from "@nestjs/common";
import { NotFoundError, RetentionExceededError } from "../../api/errors/domain-errors.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { StorageTenancyError } from "../../lib/storage/storage-keys.js";
import { TenantObjectStore } from "../../lib/storage/tenant-object-store.js";
import { resolveRetentionCutoff, resolveWorkspaceRetention } from "../../workers/rollup/retention.js";
import { assertProjectInScope } from "../../tenancy/project-scope.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";

// STORY-181 AC4 - `GET /v1/results/{id}/raw`, the verbatim raw capture as a 60-second signed redirect.
//
// MINTING THE URL IS A LOCAL SIGNATURE (ObjectStoragePort.presignGet: "computed locally, no network call"), so this request handler
// makes no network call and holds no transaction across one (KAD-06 / NFR-ARCH-04). It does NOT check the object exists: a row whose
// key points at nothing yields a URL that 404s at S3. That is the same integrity violation the parser reports loudly; the capture
// step's upload-before-insert order is what keeps it from arising.

/** api-specification.md section 3: "302 to a 60-second pre-signed URL". Passed explicitly: the store's own default is 300. */
export const RAW_DOWNLOAD_URL_SECONDS = 60;

const logger = new Logger("raw-download");

@Injectable()
export class RawDownloadService {
  constructor(private readonly store: TenantObjectStore) {}

  async signedUrl(resultId: string): Promise<{ url: string }> {
    const tenant = currentTenantStore();
    if (tenant === undefined) throw new Error("RawDownloadService requires an active tenant context");

    const found = await tenant.client.query<{ project_id: string; captured_at: Date; raw_object_key: string | null; raw_expired: string | null }>(
      `SELECT project_id, captured_at, raw_object_key, payload->>'raw_expired' AS raw_expired
         FROM answer_captures
        WHERE id = $1`,
      [resultId],
    );
    const capture = found.rows[0];
    if (capture === undefined) throw new NotFoundError({ message: "no such result" });
    // The id names a result, not a project: a scoped member is checked against the row's own project (403, never 404).
    await assertProjectInScope(tenant.client, capture.project_id);

    // RETENTION BEFORE EXISTENCE. Past the plan's raw-capture window the answer is gone BY POLICY, which is 507, not "never had one".
    // Two ways to be past it: the row is older than the window, or the retention sweep already expired it (key nulled, flagged).
    const retention = await resolveWorkspaceRetention(tenant.client, tenant.context.workspaceId);
    const cutoff = resolveRetentionCutoff(retention.rawCapturesDays, new Date());
    if (capture.raw_expired === "true" || (cutoff !== null && capture.captured_at < cutoff)) {
      incrementCounter("nominara_capture_raw_download_total", { outcome: "retention_exceeded" });
      throw new RetentionExceededError({ message: "this capture is past the workspace's raw-capture retention" });
    }

    // A legacy row (captured before raw objects existed) or a reused row has no object of its own: nothing to redirect to. A reused
    // row is NEVER pointed at its source's object, which may belong to another workspace's shared-cache entry.
    if (capture.raw_object_key === null) {
      incrementCounter("nominara_capture_raw_download_total", { outcome: "no_object" });
      throw new NotFoundError({ message: "this capture has no stored raw object" });
    }

    try {
      const url = await this.store.presignGetStored("raw", capture.raw_object_key, { expiresInSeconds: RAW_DOWNLOAD_URL_SECONDS });
      incrementCounter("nominara_capture_raw_download_total", { outcome: "signed" });
      return { url };
    } catch (error) {
      if (error instanceof StorageTenancyError) {
        // A key outside this workspace's prefix is corruption or an attack, never a lookup miss. IDs only: no key, no URL.
        incrementCounter("nominara_capture_raw_download_total", { outcome: "tenancy_refused" });
        logger.warn({ event: "raw_object_tenancy_refused", workspace_id: tenant.context.workspaceId, result_id: resultId });
      }
      throw error;
    }
  }
}

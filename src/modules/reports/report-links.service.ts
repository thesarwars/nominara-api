import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Pool } from "pg";
import { REPORT_LINK_REDIRECT_SECONDS, type ReportLinkParams, type ReportLinkRevokeParams, type ReportLinkRevokeResponse } from "../../../contracts/reports/index.js";
import { NotFoundError, TokenRevokedError } from "../../api/errors/domain-errors.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { isStoredObjectKey } from "../../lib/reports/artifact-key.js";
import { hashReportLinkToken } from "../../lib/reports/report-artifact-mail.js";
import { StorageTenancyError } from "../../lib/storage/storage-keys.js";
import { TenantObjectStore, type BoundObjectStore } from "../../lib/storage/tenant-object-store.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { currentTenantStore, withTenantContext } from "../../tenancy/tenant-context.js";

// STORY-180 AC3 (owner decision 54 (3), option 3B) - GET /v1/report-links/{workspaceId}/{token}.
//
// The 7-day link in a scheduled-report email for a file over 8 MiB. A click checks the STORED, REVOCABLE token and redirects to a
// FRESH presigned URL that lives 15 minutes (read through `presignGetStored`, so a key outside the workspace is refused). Nothing
// here signs with a static key, and nothing dies with an STS session.
//
// PUBLIC AND TENANT-LESS: the visitor has no session. The workspace id in the path only selects whose row-level security the lookup
// runs under; it proves nothing (a workspace id is not a secret). The token's SHA-256 is the credential, matched by equality on a
// unique index inside THAT workspace (row-level security is the guarantee; the workspace predicate is for the planner), so a token from workspace A presented under workspace B finds no row. The context carries the
// system actor and runs only the two statements below.
//
// ONE NEUTRAL REFUSAL. An unknown token, the wrong workspace, an expired link, an artifact whose file is not stored (marker key), and a
// stored key outside the workspace prefix are all the same 404, so the route is not an oracle for which tokens exist. The reason goes
// to the log (workspace ID only) and to a counter, never to the caller. ONE EXCEPTION (owner decision 60 (d)): a token that matches a
// live artifact IN THE PATH'S WORKSPACE but was revoked answers 401 `token_revoked`, "This link was revoked." - reachable only by
// holding the real token, so it is not an oracle. No network call is made (KAD-06): the presign is a local signature and runs after
// the lookup transaction has ended.

const logger = new Logger("report-links");

const refusal = (): InstanceType<typeof NotFoundError> => new NotFoundError({ message: "this link is not valid" });

@Injectable()
export class ReportLinksService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly objects: TenantObjectStore,
  ) {}

  async resolve(params: ReportLinkParams): Promise<{ url: string }> {
    const started = Date.now();
    let outcome = "error";
    try {
      const url = await this.lookup(params);
      outcome = "redirected";
      return { url };
    } catch (error) {
      outcome = error instanceof NotFoundError ? "refused" : error instanceof TokenRevokedError ? "revoked" : error instanceof Error ? error.name : "error";
      throw error;
    } finally {
      incrementCounter("nominara_reports_link_clicks_total", { outcome });
      // Workspace ID and outcome only: never the token, the URL or the key.
      logger.log({ span: "reports.link.resolve", workspace_id: params.workspaceId, outcome, duration_ms: Date.now() - started });
    }
  }

  /** A click is counted only once it is served (not when the presign was refused). A failed count is logged and counted; it never withholds the file. */
  private async countClick(params: ReportLinkParams): Promise<void> {
    try {
      const client = await this.pool.connect();
      try {
        await withTenantContext(client, { workspaceId: params.workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) =>
          tx.query("UPDATE report_artifacts SET download_count = download_count + 1 WHERE link_token_hash = $1 AND workspace_id = app.current_workspace()", [hashReportLinkToken(params.token)]),
        );
      } finally {
        client.release();
      }
    } catch {
      incrementCounter("nominara_reports_link_clicks_total", { outcome: "count_failed" });
      logger.error({ span: "reports.link.resolve", workspace_id: params.workspaceId, outcome: "count_failed" });
    }
  }

  /**
   * Owner decision 60 (d). Revokes the link of one artifact of the caller's workspace, on the ambient request transaction. Idempotent:
   * the FIRST revocation's time is kept. An artifact that is not in this workspace is a 404 (the RLS predicate and the explicit one).
   */
  async revoke(params: ReportLinkRevokeParams): Promise<ReportLinkRevokeResponse> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("ReportLinksService.revoke requires an active tenant context");
    const result = await store.client.query<{ id: string; link_revoked_at: Date }>(
      `UPDATE report_artifacts SET link_revoked_at = COALESCE(link_revoked_at, now())
        WHERE id = $1 AND workspace_id = app.current_workspace()
        RETURNING id, link_revoked_at`,
      [params.id],
    );
    const row = result.rows[0];
    if (row === undefined) {
      incrementCounter("nominara_reports_link_revocations_total", { outcome: "not_found" });
      throw new NotFoundError({ message: "no such export" });
    }
    incrementCounter("nominara_reports_link_revocations_total", { outcome: "revoked" });
    // Workspace ID only: never the artifact id, the token or the URL.
    logger.log({ span: "reports.link.revoke", workspace_id: store.context.workspaceId, outcome: "revoked" });
    return { export_id: row.id, link_revoked_at: row.link_revoked_at.toISOString() };
  }

  private async lookup(params: ReportLinkParams): Promise<string> {
    const client = await this.pool.connect();
    let found: { key: string | undefined; revoked: boolean; bound: BoundObjectStore };
    try {
      found = await withTenantContext(client, { workspaceId: params.workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        // Expiry and the workspace's own state are decided in the WHERE clause, by the database clock. Revocation is returned, not
        // filtered, so a revoked link can say so; it is only ever returned for the real token's hash in THIS workspace.
        const bound = this.objects.bind();
        const hit = await tx.query<{ object_key: string; revoked: boolean }>(
          `SELECT a.object_key, (a.link_revoked_at IS NOT NULL) AS revoked FROM report_artifacts a
            WHERE a.link_token_hash = $1 AND a.workspace_id = app.current_workspace() AND a.expires_at > now()
              AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id = a.workspace_id AND w.deleted_at IS NULL AND w.deletion_execute_at IS NULL)`,
          [hashReportLinkToken(params.token)],
        );
        return { key: hit.rows[0]?.object_key, revoked: hit.rows[0]?.revoked === true, bound };
      });
    } finally {
      client.release();
    }
    const { key, revoked, bound } = found;
    if (key === undefined) throw refusal();
    if (revoked) throw new TokenRevokedError({ message: "This link was revoked." });
    // A marker (pending, failed, purged) is not a key: nothing is presigned and nothing is guessed.
    if (!isStoredObjectKey(key)) throw refusal();
    // Minted AFTER the transaction ended: no pooled connection is held while the SDK may resolve credentials.
    try {
      const url = await bound.presignGetStored("reports", key, { expiresInSeconds: REPORT_LINK_REDIRECT_SECONDS });
      await this.countClick(params);
      return url;
    } catch (error) {
      if (error instanceof StorageTenancyError) {
        // Corruption or an attack, never a lookup miss: refused, and loud in the log.
        incrementCounter("nominara_reports_link_clicks_total", { outcome: "tenancy_refused" });
        logger.warn({ event: "report_object_tenancy_refused", workspace_id: params.workspaceId });
        throw refusal();
      }
      throw error;
    }
  }
}

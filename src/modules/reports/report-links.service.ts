import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Pool } from "pg";
import { REPORT_LINK_REDIRECT_SECONDS, type ReportLinkParams } from "../../../contracts/reports/index.js";
import { NotFoundError } from "../../api/errors/domain-errors.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { hashReportLinkToken } from "../../lib/reports/report-artifact-mail.js";
import { StorageTenancyError } from "../../lib/storage/storage-keys.js";
import { TenantObjectStore } from "../../lib/storage/tenant-object-store.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";

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
// ONE NEUTRAL REFUSAL. An unknown token, the wrong workspace, a revoked or expired link, an artifact whose file never landed, and a
// stored key outside the workspace prefix are all the same 404, so the route is not an oracle for which tokens exist. The reason goes
// to the log (workspace ID only) and to a counter, never to the caller. No network call is made (KAD-06): the presign is a local
// signature.

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
      outcome = error instanceof NotFoundError ? "refused" : error instanceof Error ? error.name : "error";
      throw error;
    } finally {
      incrementCounter("nominara_reports_link_clicks_total", { outcome });
      // Workspace ID and outcome only: never the token, the URL or the key.
      logger.log({ span: "reports.link.resolve", workspace_id: params.workspaceId, outcome, duration_ms: Date.now() - started });
    }
  }

  private async lookup(params: ReportLinkParams): Promise<string> {
    const client = await this.pool.connect();
    try {
      return await withTenantContext(client, { workspaceId: params.workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        const bound = this.objects.bind();
        // Revocation and expiry are decided in the WHERE clause, by the database clock. A click is counted only when it is served.
        const found = await tx.query<{ object_key: string }>(
          `UPDATE report_artifacts SET download_count = download_count + 1
            WHERE link_token_hash = $1 AND workspace_id = $2 AND link_revoked_at IS NULL AND expires_at > now()
        RETURNING object_key`,
          [hashReportLinkToken(params.token), params.workspaceId],
        );
        const key = found.rows[0]?.object_key;
        if (key === undefined || key.startsWith("pending:")) throw refusal();
        try {
          return await bound.presignGetStored("reports", key, { expiresInSeconds: REPORT_LINK_REDIRECT_SECONDS });
        } catch (error) {
          if (error instanceof StorageTenancyError) {
            // Corruption or an attack, never a lookup miss: refused, and loud in the log.
            incrementCounter("nominara_reports_link_clicks_total", { outcome: "tenancy_refused" });
            logger.warn({ event: "report_object_tenancy_refused", workspace_id: params.workspaceId });
            throw refusal();
          }
          throw error;
        }
      });
    } finally {
      client.release();
    }
  }
}

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { NotFoundError, TokenRevokedError } from "../../../src/api/errors/domain-errors.js";
import { resolvePassword } from "../../../src/db/dev-credentials.js";
import { hashReportLinkToken, reportLinkToken } from "../../../src/lib/reports/report-artifact-mail.js";
import { TenantObjectStore } from "../../../src/lib/storage/tenant-object-store.js";
import type { ObjectStoragePort } from "../../../src/lib/storage/storage.port.js";
import { ReportLinksService } from "../../../src/modules/reports/report-links.service.js";
import { WORKSPACE_GUC } from "../../../src/tenancy/constants.js";
import { connectSuperuser, type AssertionContext } from "../support/assertion-context.js";
import { connectAsRole } from "../support/runtime-roles.js";
import type { Breaker } from "../support/breakers.js";

// STORY-180 r5 (owner decision 60) - ISO-31: a report-link token from workspace A can never serve workspace B's object, and a foreign,
// expired or revoked token is refused.
//
// The emailed report link (GET /v1/report-links/{workspaceId}/{token}) is PUBLIC and TENANT-LESS: the visitor has no session, so the
// workspace in the path only selects whose row-level security the lookup runs under. Three things keep a token inside its workspace and
// each is exercised here against the REAL service, the REAL runtime role (nominara_app, NOBYPASSRLS) and the REAL database:
//
//   L1  row-level security alone: with workspace B's context set, A's token hash is invisible (and with no context nothing is);
//   L2  the service's refusal matrix, for every (token, path workspace) pair of the three-tenant fixture: only the token's own workspace
//       serves it, and what is presigned is always inside THAT workspace's object prefix; an expired token is the neutral refusal; a
//       revoked token is refused (never served); a row whose stored key points into another workspace's prefix is refused;
//   L3  the unique index on link_token_hash: a hash names one artifact, in one workspace.
//
// All violations are collected and reported together, so a single message names every layer that is open. Probe rows are inserted with
// the superuser (the seed is not touched) and removed in `finally`.

const ENV = "iso";
const SIGNING_KEY = Buffer.alloc(32, 7);

interface Probe {
  readonly id: string;
  readonly workspaceId: string;
  readonly token: string;
  readonly key: string;
}

export async function assertIso31ReportLinkTokenIsolation(ctx: AssertionContext): Promise<void> {
  const tenants = [ctx.fixture.a, ctx.fixture.b, ctx.fixture.c];
  const violations: string[] = [];
  const superuser = await connectSuperuser(ctx);
  const ids: string[] = [];
  const presigned: string[] = [];
  const port: ObjectStoragePort = {
    put: async () => undefined,
    get: async () => Buffer.alloc(0),
    head: async () => ({ contentLength: 0, contentType: null, etag: null, serverSideEncryption: null }),
    delete: async () => undefined,
    presignGet: async (bucket, key) => {
      presigned.push(key);
      return `https://objects.invalid/${bucket}/${key}`;
    },
  };
  const pool = new Pool({ host: ctx.target.host, port: ctx.target.port, database: ctx.target.database, user: "nominara_app", password: resolvePassword("nominara_app") });
  try {
    const insert = async (workspaceId: string, over: { objectWorkspaceId?: string; expired?: boolean; revoked?: boolean } = {}): Promise<Probe> => {
      const id = randomUUID();
      const token = reportLinkToken(SIGNING_KEY, id);
      const key = `${ENV}/${over.objectWorkspaceId ?? workspaceId}/${id}.pdf`;
      await superuser.query(
        `INSERT INTO report_artifacts (id, workspace_id, project_ids, period_start, period_end, format, object_key, bytes, methodology_footer, expires_at, link_token_hash, link_revoked_at)
         VALUES ($1,$2,'{}',CURRENT_DATE,CURRENT_DATE,'pdf',$3,10,'{}'::jsonb, $4, $5, $6)`,
        [
          id, workspaceId, key,
          over.expired === true ? new Date(Date.now() - 60_000) : new Date(Date.now() + 7 * 86_400_000),
          hashReportLinkToken(token),
          over.revoked === true ? new Date() : null,
        ],
      );
      ids.push(id);
      return { id, workspaceId, token, key };
    };

    const probes = await Promise.all(tenants.map((t) => insert(t.workspaceId)));
    const expired = await insert(ctx.fixture.a.workspaceId, { expired: true });
    const revoked = await insert(ctx.fixture.a.workspaceId, { revoked: true });
    const forged = await insert(ctx.fixture.a.workspaceId, { objectWorkspaceId: ctx.fixture.b.workspaceId });

    // ---- L1: row-level security alone (no workspace predicate, no service) ----
    const app = await connectAsRole(ctx.target, "nominara_app");
    try {
      const noContext = await app.query("SELECT count(*)::int AS n FROM report_artifacts WHERE link_token_hash = $1", [hashReportLinkToken(probes[0]!.token)]);
      if (noContext.rows[0].n !== 0) violations.push(`L1: with NO tenant context nominara_app read ${String(noContext.rows[0].n)} row(s) by a link token hash`);
      for (const viewer of tenants) {
        await app.query("BEGIN");
        try {
          await app.query("SELECT set_config($1, $2, true)", [WORKSPACE_GUC, viewer.workspaceId]);
          for (const probe of probes) {
            const r = await app.query("SELECT count(*)::int AS n FROM report_artifacts WHERE link_token_hash = $1", [hashReportLinkToken(probe.token)]);
            const expectedRows = probe.workspaceId === viewer.workspaceId ? 1 : 0;
            if (r.rows[0].n !== expectedRows) violations.push(`L1: in tenant ${viewer.label}'s context a token of workspace ${probe.workspaceId === viewer.workspaceId ? "A-own" : "foreign"} matched ${String(r.rows[0].n)} row(s), expected ${String(expectedRows)}`);
          }
        } finally {
          await app.query("ROLLBACK");
        }
      }
    } finally {
      await app.end();
    }

    // ---- L2: the service's refusal matrix ----
    const service = new ReportLinksService(pool as never, new TenantObjectStore(port, ENV));
    const attempt = async (workspaceId: string, token: string): Promise<{ url?: string; error?: unknown }> => {
      try {
        return { url: (await service.resolve({ workspaceId, token })).url };
      } catch (error) {
        return { error };
      }
    };
    for (const probe of probes) {
      for (const pathWorkspace of tenants) {
        presigned.length = 0;
        const r = await attempt(pathWorkspace.workspaceId, probe.token);
        if (pathWorkspace.workspaceId === probe.workspaceId) {
          if (r.url === undefined) violations.push(`L2: a valid token was not served in its own workspace (${String(r.error)})`);
          else if (!r.url.includes(`/${ENV}/${probe.workspaceId}/${probe.id}.pdf`)) violations.push("L2: a valid token was served an object outside its own workspace prefix");
        } else {
          if (r.url !== undefined) violations.push(`L2: a token of workspace ${probe.workspaceId} was SERVED under workspace ${pathWorkspace.workspaceId}`);
          else if (!(r.error instanceof NotFoundError)) violations.push(`L2: a foreign token under workspace ${pathWorkspace.workspaceId} was not the neutral refusal (${String(r.error)})`);
          if (presigned.length > 0) violations.push("L2: a foreign token caused an object to be presigned");
        }
      }
    }
    const own = ctx.fixture.a.workspaceId;
    presigned.length = 0;
    const expiredResult = await attempt(own, expired.token);
    if (expiredResult.url !== undefined || !(expiredResult.error instanceof NotFoundError)) violations.push("L2: an EXPIRED token was not refused with the neutral refusal");
    const revokedResult = await attempt(own, revoked.token);
    if (revokedResult.url !== undefined || !(revokedResult.error instanceof TokenRevokedError)) violations.push("L2: a REVOKED token was served or not refused as revoked");
    const revokedForeign = await attempt(ctx.fixture.b.workspaceId, revoked.token);
    if (revokedForeign.url !== undefined || !(revokedForeign.error instanceof NotFoundError)) violations.push("L2: a revoked token under ANOTHER workspace was not the neutral refusal (the revoked answer must need the right workspace)");
    const forgedResult = await attempt(own, forged.token);
    if (forgedResult.url !== undefined || !(forgedResult.error instanceof NotFoundError)) violations.push("L2: a row whose stored key points into another workspace was served");
    if (presigned.length > 0) violations.push("L2: an expired, revoked or forged token caused an object to be presigned");
    const unknown = await attempt(own, reportLinkToken(Buffer.alloc(32, 1), randomUUID()));
    if (unknown.url !== undefined || !(unknown.error instanceof NotFoundError)) violations.push("L2: an unknown token was not the neutral refusal");

    // ---- L3: a hash names one artifact ----
    try {
      await superuser.query(
        `INSERT INTO report_artifacts (workspace_id, project_ids, period_start, period_end, format, object_key, bytes, methodology_footer, expires_at, link_token_hash)
         VALUES ($1,'{}',CURRENT_DATE,CURRENT_DATE,'pdf','k',1,'{}'::jsonb, now() + interval '1 day', $2)`,
        [ctx.fixture.b.workspaceId, hashReportLinkToken(probes[0]!.token)],
      );
      violations.push("L3: two artifacts (in different workspaces) were allowed to share one link token hash");
      await superuser.query("DELETE FROM report_artifacts WHERE workspace_id = $1 AND object_key = 'k' AND link_token_hash = $2", [ctx.fixture.b.workspaceId, hashReportLinkToken(probes[0]!.token)]);
    } catch (error) {
      if ((error as { code?: string }).code !== "23505") violations.push(`L3: sharing a link token hash failed for the wrong reason (${String((error as Error).message)})`);
    }
  } finally {
    await pool.end().catch(() => undefined);
    if (ids.length > 0) await superuser.query("DELETE FROM report_artifacts WHERE id = ANY($1::uuid[])", [ids]).catch(() => undefined);
    await superuser.end();
  }

  if (violations.length > 0) {
    throw new Error(`ISO-31: report-link token isolation does not hold (${String(violations.length)} violation(s)): ${violations.join("; ")}`);
  }
}

// The mutation: the tenant policy on report_artifacts admits every row (L1 opens), and the unique index on the token hash is gone (L3
// opens). Both are schema-local to the disposable database copy and vanish with it. (The service-level layers are mutation-tested
// against the source separately; the registry allows one breaker per assertion.)
export const iso31Breaker: Breaker = {
  id: "ISO-31",
  description: "replaces report_artifacts' tenant policy with USING (true) and drops the unique index on link_token_hash",
  apply: async (client) => {
    await client.query("DROP POLICY IF EXISTS ws_isolation_report_artifacts ON report_artifacts");
    await client.query("CREATE POLICY ws_isolation_report_artifacts ON report_artifacts USING (true) WITH CHECK (true)");
    await client.query("DROP INDEX IF EXISTS ux_report_artifacts_link_token");
  },
  revert: async () => {
    // schema-local to the disposable database; dropped with it
  },
};

import { CallHandler, ExecutionContext, Inject, Injectable, Logger, NestInterceptor } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import type { Pool } from "pg";
import { from, lastValueFrom, type Observable } from "rxjs";
import { loadEnv } from "../../config/env.js";
import { PG_POOL, PORTAL_PG_POOL } from "../../db/pg-pool.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import type { PortalFacts } from "../../lib/portal/portal-facts.js";
import { AgencyService } from "../../modules/agency/agency.service.js";
import { ProjectsService } from "../../modules/projects/projects.service.js";
import { WorkspacesService } from "../../modules/workspaces/workspaces.service.js";
import { ShareTokensService, type PortalSessionPolicy } from "../../modules/agency/share-tokens.service.js";
import { loadPortalCookieKey, openPortalCookie, PORTAL_COOKIE_NAME } from "../../modules/portal/portal-cookie.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";
import type { PortalRequest, PortalSessionContext } from "../decorators/portal-route.decorator.js";
import { DegradedError, TokenRevokedError, UnauthenticatedError } from "../errors/domain-errors.js";

/** FR-AGY-01q: private and non-cacheable by header; the portal host's robots file is the other half. */
export const PORTAL_RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

interface CookieRequest extends PortalRequest {
  cookies?: Record<string, string | undefined>;
}

const logger = new Logger("portal-context");

// STORY-098 part B — security-and-tenancy.md §3/§4 and integrations-and-sharing.md §3 "GET /portal/*": the origin
// sets app.current_workspace_id and app.current_scope_projects FROM THE COOKIE, inside the transaction.
//
// Order, and why:
//   1. headers first, so a refusal is as uncacheable as a success;
//   2. open the cookie (signature, encryption, expiry, strict shape) — no cookie, no work, no database;
//   3. FR-AGY-01m: re-check the token on EVERY request, on the app pool in its own short transaction scoped to the
//      cookie's workspace. A revoked / expired / deleted token, or a cookie whose workspace is not the token's, ends
//      the session here — before the portal pool is touched. Nothing is held open across it: the transaction is closed
//      before the portal one begins, and neither awaits anything external;
//   4. open ONE transaction on the PORTAL pool (a different connection string, a different database role:
//      `nominara_portal`, SELECT only), READ ONLY, with the workspace and scope GUCs set `is_local` from the cookie.
//      withTenantContext is the same seam every tenant request uses, so currentTenantStore() works for the services
//      the handler calls, and the BEGIN/set_config/COMMIT/ROLLBACK discipline is not reimplemented.
//
// The request's path, query and headers are never consulted for tenant or scope.
@Injectable()
export class PortalContextInterceptor implements NestInterceptor {
  constructor(
    @Inject(PG_POOL) private readonly appPool: Pool,
    @Inject(PORTAL_PG_POOL) private readonly portalPool: Pool | null,
    private readonly shareTokens: ShareTokensService,
    private readonly workspaces: WorkspacesService,
    private readonly projects: ProjectsService,
    private readonly agency: AgencyService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const req = http.getRequest<CookieRequest>();
    const reply = http.getResponse<FastifyReply>();
    for (const [name, value] of Object.entries(PORTAL_RESPONSE_HEADERS)) reply.header(name, value);

    const env = loadEnv();
    // Fail closed: no key or no portal pool means the portal is not configured, never that it is open.
    if (this.portalPool === null || env.PORTAL_COOKIE_KEY === undefined) {
      throw new DegradedError({ message: "the portal is not available" });
    }

    const raw = req.cookies?.[PORTAL_COOKIE_NAME];
    const payload = raw === undefined ? null : await openPortalCookie(raw, loadPortalCookieKey(env.PORTAL_COOKIE_KEY));
    if (payload === null) {
      incrementCounter("nominara_portal_request_refusals_total", { reason: "no_session" });
      throw new UnauthenticatedError({ message: "no portal session" });
    }

    const resolved = await this.resolveOnAppPool(payload.workspace_id, payload.token_id, payload.scope_project_ids, payload.theme_id);
    if (resolved === null) {
      incrementCounter("nominara_portal_request_refusals_total", { reason: "token_not_live" });
      logger.log(`portal request refused workspace_id=${payload.workspace_id} reason=token_not_live`);
      throw new TokenRevokedError({ message: "this link is no longer available" });
    }

    const session: PortalSessionContext = {
      tokenId: payload.token_id,
      workspaceId: payload.workspace_id,
      scopeProjectIds: payload.scope_project_ids,
      scopeTabs: payload.scope_tabs,
      themeId: payload.theme_id,
      policy: resolved.policy,
      facts: resolved.facts,
    };
    req.portal = session;

    const client = await this.portalPool.connect();
    return from(
      withTenantContext(
        client,
        { workspaceId: session.workspaceId, actorId: SYSTEM_ACTOR_ID, scopeProjectIds: session.scopeProjectIds },
        async (tx) => {
          // Defence in depth beneath the role's SELECT-only grants: a portal request cannot write even if a route did.
          await tx.query("SET LOCAL TRANSACTION READ ONLY");
          return lastValueFrom(next.handle());
        },
      ).finally(() => client.release()),
    );
  }

  // Everything the portal reads need that `nominara_portal` has no policy on, read on the APP pool in the same short
  // workspace-scoped transaction as the liveness check (NEW-E-099a): the workspace's timezone, name, scoring version and
  // overrides, the theme, and the scoped projects' engine rows. A dead token ends here, before any of it is read.
  private async resolveOnAppPool(
    workspaceId: string,
    tokenId: string,
    scopeProjectIds: readonly string[],
    themeId: string | null,
  ): Promise<{ policy: PortalSessionPolicy; facts: PortalFacts } | null> {
    const client = await this.appPool.connect();
    try {
      return await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async () => {
        const policy = await this.shareTokens.resolveSession(tokenId);
        if (policy === null) return null;
        const [workspace, theme, engines] = await Promise.all([
          this.workspaces.portalFacts(),
          this.agency.themeForPortal(themeId),
          this.projects.portalEngines(scopeProjectIds),
        ]);
        return { policy, facts: { workspace, theme, engines } };
      });
    } finally {
      client.release();
    }
  }
}

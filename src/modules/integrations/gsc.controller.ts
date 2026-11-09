import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  gscConnectionSchema,
  gscOauthCallbackQuerySchema,
  gscOauthStartRequestSchema,
  gscOauthStartResponseSchema,
  gscSyncResponseSchema,
  type GscConnection,
  type GscOauthCallbackQuery,
  type GscOauthStartRequest,
  type GscOauthStartResponse,
  type GscSyncResponse,
} from "../../../contracts/integrations/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { Public } from "../../api/decorators/public.decorator.js";
import { RequireFeature } from "../../api/decorators/require-entitlement.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ScopedByQuery } from "../../api/decorators/scoped-by-query.decorator.js";
import { SkipTenantContext } from "../../api/decorators/skip-tenant-context.decorator.js";
import type { RbacScopedRequest } from "../../api/guards/rbac.guard.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { OAUTH_BINDING_COOKIE_NAME, setOauthBindingCookie } from "../../lib/auth/cookies.js";
import { GSC_STATE_TTL_MS } from "./gsc-oauth-state.js";
import { GscService } from "./gsc.service.js";

// STORY-115 - `/integrations/gsc/*`. No logic here: each handler resolves the request and calls one service method.
//   start     `workspace:update`, plan must include Search Console. Sets the browser-binding cookie the callback checks.
//   callback  PUBLIC and tenant-less, because Google redirects the browser here (a GET; the specification's POST is a documentation
//             error). The signed state names the workspace; the binding cookie proves the browser.
//   get       `project:read`, narrowed to the caller's projects by the service's query.
//   delete    `workspace:update`; the 204 is an audited disconnect.
//   sync      `workspace:update`; queues one job, 0 credits.
@Controller("integrations/gsc")
export class GscController {
  constructor(private readonly gsc: GscService) {}

  @Post("oauth/start")
  @HttpCode(200)
  @RequirePermission("workspace:update")
  @RequireFeature("integrations.gsc")
  // Starting is audited as an act of the workspace (the project id is in the body, not the URL). The authorisation URL carries the signed
  // state, so it is never recorded: only the property type is.
  @Audit({ action: "gsc.oauth_started", resourceType: "workspace", resourceIdFrom: "workspace", afterState: (body) => ({ property_type: (body as GscOauthStartResponse).property_type }) })
  @ApiContract({ operationId: "startGscOauth", requestSchema: gscOauthStartRequestSchema, responseSchema: gscOauthStartResponseSchema })
  async start(
    @Req() req: RbacScopedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body(new ZodValidationPipe(gscOauthStartRequestSchema)) body: GscOauthStartRequest,
  ): Promise<GscOauthStartResponse> {
    const result = await this.gsc.start(req.tenant!.workspaceId, req.tenant!.actorId, body);
    setOauthBindingCookie(reply, result.bindingValue, GSC_STATE_TTL_MS / 1000);
    return result.body;
  }

  @Get("oauth/callback")
  @Public()
  @SkipTenantContext()
  @ApiContract({ operationId: "gscOauthCallback", querySchema: gscOauthCallbackQuerySchema, responseSchema: gscConnectionSchema })
  callback(
    @Req() req: FastifyRequest,
    @Query(new ZodValidationPipe(gscOauthCallbackQuerySchema)) query: GscOauthCallbackQuery,
  ): Promise<GscConnection> {
    return this.gsc.callback(query, req.cookies?.[OAUTH_BINDING_COOKIE_NAME]);
  }

  @Get(":id")
  @RequirePermission("project:read")
  @ScopedByQuery()
  @ApiContract({ operationId: "getGscConnection", responseSchema: gscConnectionSchema })
  get(@Param("id") id: string): Promise<GscConnection> {
    return this.gsc.get(id);
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("workspace:update")
  @Audit({ action: "gsc.disconnected", resourceType: "gsc_connection", resourceIdFrom: "params", severity: "notice" })
  @ApiContract({ operationId: "disconnectGsc", voidResponse: true })
  disconnect(@Req() req: RbacScopedRequest, @Param("id") id: string): Promise<void> {
    return this.gsc.disconnect(req.tenant!.workspaceId, id);
  }

  @Post(":id/sync")
  @HttpCode(202)
  @RequirePermission("workspace:update")
  @Audit({ action: "gsc.sync_requested", resourceType: "gsc_connection", resourceIdFrom: "params" })
  @ApiContract({ operationId: "syncGsc", responseSchema: gscSyncResponseSchema })
  sync(@Req() req: RbacScopedRequest, @Param("id") id: string): Promise<GscSyncResponse> {
    return this.gsc.sync(req.tenant!.workspaceId, id);
  }
}

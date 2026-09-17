import { Controller, Delete, Param, Post, Query, Get, Req, Res } from "@nestjs/common";
import { paginationRequestSchema, type PaginationRequest } from "../../../contracts/common/pagination.schema.js";
import type { Page } from "../../api/pagination/page.js";
import type { FastifyReply } from "fastify";
import type { AuthenticatedRequest } from "../../api/guards/auth.guard.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Public } from "../../api/decorators/public.decorator.js";
import { SkipTenantContext } from "../../api/decorators/skip-tenant-context.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { OAUTH_BINDING_COOKIE_NAME, ACCESS_COOKIE_NAME, setAuthCookies, setOauthBindingCookie } from "../../lib/auth/cookies.js";
import {
  oauthCallbackQuerySchema,
  oauthCallbackResponseSchema,
  oauthLinkResponseSchema,
  oauthProviderSchema,
  oauthStartResponseSchema,
  type OauthCallbackQuery,
  type OauthCallbackResponse,
  type OauthLinkItem,
  type OauthProvider,
  type OauthStartResponse,
} from "./dto/index.js";
import { OAUTH_BINDING_COOKIE_MAX_AGE_SECONDS, OauthService } from "./oauth.service.js";

// STORY-015 — thin HTTP surface only (coding-standards.md §1: a conditional
// here is a smell). Every branch (state/binding/purpose/subject
// resolution) lives in OauthService; this file validates and delegates.
interface OauthRequest extends AuthenticatedRequest {
  readonly id?: string | number;
}

function requestIdOf(req: OauthRequest): string {
  return req.id !== undefined ? String(req.id) : "";
}

@Controller()
export class OauthController {
  constructor(private readonly service: OauthService) {}

  @Post("auth/oauth/:provider/start")
  @Public()
  @ApiContract({ operationId: "startOauth", paramsSchema: oauthProviderSchema, responseSchema: oauthStartResponseSchema })
  async start(
    @Param("provider", new ZodValidationPipe(oauthProviderSchema)) provider: OauthProvider,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<OauthStartResponse> {
    const result = await this.service.start(provider, "login", null);
    setOauthBindingCookie(reply, result.bindingValue, OAUTH_BINDING_COOKIE_MAX_AGE_SECONDS);
    return { authorization_url: result.authorizationUrl, state_expires_at: result.stateExpiresAt.toISOString() };
  }

  @Post("auth/oauth/:provider/link/start")
  @SkipTenantContext()
  @ApiContract({ operationId: "startOauthLink", paramsSchema: oauthProviderSchema, responseSchema: oauthStartResponseSchema })
  async linkStart(
    @Req() req: AuthenticatedRequest,
    @Param("provider", new ZodValidationPipe(oauthProviderSchema)) provider: OauthProvider,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<OauthStartResponse> {
    const result = await this.service.start(provider, "link", req.auth!.sub);
    setOauthBindingCookie(reply, result.bindingValue, OAUTH_BINDING_COOKIE_MAX_AGE_SECONDS);
    return { authorization_url: result.authorizationUrl, state_expires_at: result.stateExpiresAt.toISOString() };
  }

  @Get("auth/oauth/:provider/callback")
  @Public()
  @SkipTenantContext()
  @ApiContract({
    operationId: "oauthCallback",
    paramsSchema: oauthProviderSchema,
    querySchema: oauthCallbackQuerySchema,
    responseSchema: oauthCallbackResponseSchema,
  })
  async callback(
    @Req() req: OauthRequest,
    @Param("provider", new ZodValidationPipe(oauthProviderSchema)) provider: OauthProvider,
    @Query(new ZodValidationPipe(oauthCallbackQuerySchema)) query: OauthCallbackQuery,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<OauthCallbackResponse> {
    const result = await this.service.callback(
      provider,
      query,
      req.cookies?.[OAUTH_BINDING_COOKIE_NAME],
      req.cookies?.[ACCESS_COOKIE_NAME],
      requestIdOf(req),
    );
    setAuthCookies(reply, result.tokens);
    return result.body;
  }

  /**
   * STORY-096 slice C — the state BETWEEN link and unlink, which nothing could
   * read. `unlink` answers 403 for a provider that is not linked, so without
   * this a security screen's Disconnect is a button whose only outcome is an
   * error.
   *
   * ⚠ CURSOR-PAGINATED, though the realistic row count is 0–3. It is tempting
   * to call a set bounded by a three-value provider enum "not a list" and skip
   * `NFR-API-03` — but `ux_credentials_oauth` is unique on
   * `(provider, external_subject)`, NOT on `(user_id, provider)`, so one
   * person can link two different Google accounts. The set is bounded by
   * nothing the schema enforces.
   *
   * No `@RequirePermission`: a credential belongs to a PERSON, not a
   * workspace, so there is no role to check — the same reason
   * `GET /me/passkeys` carries none. `route-permission-coverage.spec.ts`
   * records it with that reason rather than letting it pass silently.
   */
  @Get("me/oauth")
  @SkipTenantContext()
  @ApiContract({
    operationId: "listOauthLinks",
    querySchema: paginationRequestSchema,
    responseSchema: oauthLinkResponseSchema,
    listOf: true,
  })
  listLinks(
    @Req() req: AuthenticatedRequest,
    @Query(new ZodValidationPipe(paginationRequestSchema)) pagination: PaginationRequest,
  ): Promise<Page<OauthLinkItem>> {
    return this.service.listLinks(req.auth!.sub, pagination);
  }

  @Delete("me/oauth/:provider")
  @SkipTenantContext()
  @ApiContract({ operationId: "unlinkOauth", paramsSchema: oauthProviderSchema, voidResponse: true })
  unlink(
    @Req() req: AuthenticatedRequest,
    @Param("provider", new ZodValidationPipe(oauthProviderSchema)) provider: OauthProvider,
  ): Promise<void> {
    return this.service.unlink(req.auth!.sub, provider);
  }
}

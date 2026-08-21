import { Controller, Delete, Param, Post, Query, Get, Req, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import type { AuthenticatedRequest } from "../../api/guards/auth.guard.js";
import { Public } from "../../api/decorators/public.decorator.js";
import { SkipTenantContext } from "../../api/decorators/skip-tenant-context.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { OAUTH_BINDING_COOKIE_NAME, ACCESS_COOKIE_NAME, setAuthCookies, setOauthBindingCookie } from "../../lib/auth/cookies.js";
import {
  oauthCallbackQuerySchema,
  oauthProviderSchema,
  type OauthCallbackQuery,
  type OauthCallbackResponse,
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

  @Delete("me/oauth/:provider")
  @SkipTenantContext()
  unlink(
    @Req() req: AuthenticatedRequest,
    @Param("provider", new ZodValidationPipe(oauthProviderSchema)) provider: OauthProvider,
  ): Promise<void> {
    return this.service.unlink(req.auth!.sub, provider);
  }
}

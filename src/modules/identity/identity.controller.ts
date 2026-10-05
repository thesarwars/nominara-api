import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, Res, UnauthorizedException } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import type { AuthenticatedRequest } from "../../api/guards/auth.guard.js";
import { paginationRequestSchema, type PaginationRequest } from "../../../contracts/common/pagination.schema.js";
import type { Page } from "../../api/pagination/page.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Public } from "../../api/decorators/public.decorator.js";
import { SkipTenantContext } from "../../api/decorators/skip-tenant-context.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { REFRESH_COOKIE_NAME, clearAuthCookies, setAuthCookies } from "../../lib/auth/cookies.js";
import {
  passkeyAddOptionsRequestSchema,
  passkeyListResponseSchema,
  type PasskeyAddOptionsRequest,
  type PasskeyListItem,
  passkeyOptionsRequestSchema,
  passkeyOptionsResponseSchema,
  passkeyRenameRequestSchema,
  passkeyVerifyRequestSchema,
  registrationVerifyRequestSchema,
  type RegistrationVerifyRequest,
  type PasskeyOptionsRequest,
  type PasskeyRenameRequest,
  type PasskeyVerifyRequest,
} from "./dto/index.js";
import { IdentityService, type PasskeyOptionsResult } from "./identity.service.js";
import { SessionService } from "./session.service.js";

// STORY-173 — POST /auth/passkey/{options,verify} are sign-in only. A passkey is
// added at POST /me/passkeys/{options,verify}: session-authenticated and
// step-up gated, the account taken from the session (req.auth.sub), never from
// the body.
//
// STORY-014 — thin HTTP surface only (coding-standards.md §1: a conditional
// here is a smell). Every branch on ceremony purpose lives in
// IdentityService; this file validates and delegates, one call each.
@Controller()
export class IdentityController {
  constructor(
    private readonly service: IdentityService,
    private readonly sessions: SessionService,
  ) {}

  @Post("auth/passkey/options")
  @Public()
  @ApiContract({
    operationId: "createPasskeyOptions",
    requestSchema: passkeyOptionsRequestSchema,
    responseSchema: passkeyOptionsResponseSchema,
  })
  options(@Body(new ZodValidationPipe(passkeyOptionsRequestSchema)) body: PasskeyOptionsRequest): Promise<PasskeyOptionsResult> {
    return this.service.createAssertionOptions(body);
  }

  // STORY-017 — no token in the body: sets Set-Cookie (access, refresh,
  // CSRF) instead. Supersedes STORY-014's Bearer-in-body contract.
  @Post("auth/passkey/verify")
  @Public()
  @HttpCode(200)
  @ApiContract({ operationId: "verifyPasskey", requestSchema: passkeyVerifyRequestSchema, voidResponse: true })
  async verify(
    @Body(new ZodValidationPipe(passkeyVerifyRequestSchema)) body: PasskeyVerifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const tokens = await this.service.verifyPasskey(body);
    setAuthCookies(reply, tokens);
  }

  @Post("auth/refresh")
  @Public()
  @HttpCode(200)
  @ApiContract({ operationId: "refreshSession", voidResponse: true })
  async refresh(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const rawRefreshToken = req.cookies?.[REFRESH_COOKIE_NAME];
    if (!rawRefreshToken) {
      throw new UnauthorizedException("missing refresh token cookie");
    }
    const tokens = await this.sessions.refresh(rawRefreshToken);
    setAuthCookies(reply, tokens);
  }

  @Post("auth/logout")
  @SkipTenantContext()
  @HttpCode(200)
  @ApiContract({ operationId: "logout", voidResponse: true })
  async logout(@Req() req: AuthenticatedRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    await this.sessions.logout(req.auth!.sid);
    clearAuthCookies(reply);
  }

  // @SkipTenantContext() — session-authenticated (AuthGuard requires a real
  // access token) but genuinely tenant-less: managing passkeys happens
  // before any workspace exists, so WorkspaceGuard never populates
  // req.tenant here, and TenantContextInterceptor must not fail-closed on
  // that the way it does for every other private route.
  @Get("me/passkeys")
  @SkipTenantContext()
  @ApiContract({
    operationId: "listPasskeys",
    querySchema: paginationRequestSchema,
    responseSchema: passkeyListResponseSchema,
    listOf: true,
  })
  list(
    @Req() req: AuthenticatedRequest,
    @Query(new ZodValidationPipe(paginationRequestSchema)) pagination: PaginationRequest,
  ): Promise<Page<PasskeyListItem>> {
    return this.service.listPasskeys(req.auth!.sub, pagination);
  }

  // STORY-173 — the ONLY way a passkey is added. Step-up and the
  // proof-of-address check live in IdentityService (a conditional here is a
  // smell); the controller hands over the session's own account and its
  // strong-auth freshness, both populated by AuthGuard, never by the body.
  @Post("me/passkeys/options")
  @SkipTenantContext()
  @ApiContract({
    operationId: "createPasskeyRegistrationOptions",
    requestSchema: passkeyAddOptionsRequestSchema,
    responseSchema: passkeyOptionsResponseSchema,
  })
  addOptions(
    @Req() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(passkeyAddOptionsRequestSchema)) body: PasskeyAddOptionsRequest,
  ): Promise<PasskeyOptionsResult> {
    return this.service.createRegistrationOptions(req.auth!.sub, req.session, body);
  }

  @Post("me/passkeys/verify")
  @SkipTenantContext()
  @HttpCode(200)
  @ApiContract({
    operationId: "verifyPasskeyRegistration",
    requestSchema: registrationVerifyRequestSchema,
    voidResponse: true,
  })
  addVerify(
    @Req() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(registrationVerifyRequestSchema)) body: RegistrationVerifyRequest,
  ): Promise<void> {
    return this.service.verifyRegistration(req.auth!.sub, req.session, body);
  }

  @Patch("me/passkeys/:id")
  @SkipTenantContext()
  @ApiContract({ operationId: "renamePasskey", requestSchema: passkeyRenameRequestSchema, voidResponse: true })
  rename(
    @Req() req: AuthenticatedRequest,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(passkeyRenameRequestSchema)) body: PasskeyRenameRequest,
  ): Promise<void> {
    return this.service.renamePasskey(req.auth!.sub, id, body.device_label);
  }

  @Delete("me/passkeys/:id")
  @SkipTenantContext()
  @ApiContract({ operationId: "revokePasskey", voidResponse: true })
  revoke(@Req() req: AuthenticatedRequest, @Param("id") id: string): Promise<void> {
    return this.service.revokePasskey(req.auth!.sub, id);
  }
}

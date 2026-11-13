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
  meResponseSchema,
  meUpdateRequestSchema,
  type MeResponse,
  type MeUpdateRequest,
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
  sessionIdParamsSchema,
  sessionListResponseSchema,
  type SessionIdParams,
  type SessionListItem,
  sessionsRevokeOthersResponseSchema,
  type SessionsRevokeOthersResponse,
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
    @Req() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(passkeyVerifyRequestSchema)) body: PasskeyVerifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const tokens = await this.service.verifyPasskey(body);
    await this.sessions.recordUserAgent(tokens.sid, req.headers?.["user-agent"]);
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
    await this.sessions.recordUserAgent(tokens.sid, req.headers?.["user-agent"]);
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

  // NEW-A-2 — the caller's own identity. Tenant-less on purpose: it answers
  // "who am I and which workspace am I in" and so must work before a workspace
  // is chosen and after a plan change has made `ent_v` stale (STORY-153). The
  // workspace returned is the verified token's `ws` claim, nothing a request
  // supplies.
  @Get("me")
  @SkipTenantContext()
  @ApiContract({ operationId: "getMe", responseSchema: meResponseSchema })
  getMe(@Req() req: AuthenticatedRequest): Promise<MeResponse> {
    return this.service.getMe(req.auth!.sub, req.auth!.ws);
  }

  @Patch("me")
  @SkipTenantContext()
  @ApiContract({ operationId: "updateMe", requestSchema: meUpdateRequestSchema, responseSchema: meResponseSchema })
  updateMe(
    @Req() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(meUpdateRequestSchema)) body: MeUpdateRequest,
  ): Promise<MeResponse> {
    return this.service.updatePersona(req.auth!.sub, req.auth!.ws, body.persona);
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
    return this.service.revokePasskey(req.auth!.sub, id, req.session, req.auth!.sid);
  }

  // STORY-018 — "sign out other sessions". Tenant-less like the rest of /me/*; the account and the session to keep both
  // come from the verified token. Step-up lives in IdentityService, as for the passkey routes.
  @Post("me/sessions/revoke-others")
  @SkipTenantContext()
  @HttpCode(200)
  @ApiContract({ operationId: "revokeOtherSessions", responseSchema: sessionsRevokeOthersResponseSchema })
  revokeOthers(@Req() req: AuthenticatedRequest): Promise<SessionsRevokeOthersResponse> {
    return this.service.revokeOtherSessions(req.auth!.sub, req.session, req.auth!.sid);
  }

  // STORY-096 AC4/AC7 — the caller's own sessions. Tenant-less like the rest of /me/*; the account and the current session come from the verified
  // token. `:id` selects a row only together with that account (SessionService.revokeOne), never alone.
  @Get("me/sessions")
  @SkipTenantContext()
  @ApiContract({
    operationId: "listSessions",
    querySchema: paginationRequestSchema,
    responseSchema: sessionListResponseSchema,
    listOf: true,
  })
  listSessions(
    @Req() req: AuthenticatedRequest,
    @Query(new ZodValidationPipe(paginationRequestSchema)) pagination: PaginationRequest,
  ): Promise<Page<SessionListItem>> {
    return this.service.listSessions(req.auth!.sub, req.auth!.sid, pagination);
  }

  @Delete("me/sessions/:id")
  @SkipTenantContext()
  @ApiContract({ operationId: "revokeSession", paramsSchema: sessionIdParamsSchema, voidResponse: true })
  async revokeSession(
    @Req() req: AuthenticatedRequest,
    @Param(new ZodValidationPipe(sessionIdParamsSchema)) params: SessionIdParams,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.service.revokeSession(req.auth!.sub, params.id, req.session, req.auth!.sid);
    // Ending the CURRENT session is a sign-out: clear the cookies exactly as logout does (decision 100g).
    if (params.id === req.auth!.sid) clearAuthCookies(reply);
  }
}

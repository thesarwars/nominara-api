import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from "@nestjs/common";
import type { AuthenticatedRequest } from "../../api/guards/auth.guard.js";
import { Public } from "../../api/decorators/public.decorator.js";
import { SkipTenantContext } from "../../api/decorators/skip-tenant-context.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import {
  passkeyOptionsRequestSchema,
  passkeyRenameRequestSchema,
  passkeyVerifyRequestSchema,
  type PasskeyOptionsRequest,
  type PasskeyRenameRequest,
  type PasskeyVerifyRequest,
} from "./dto/index.js";
import { IdentityService, type PasskeyOptionsResult, type PasskeyVerifyResult } from "./identity.service.js";

// STORY-014 — thin HTTP surface only (coding-standards.md §1: a conditional
// here is a smell). Every branch on ceremony purpose lives in
// IdentityService; this file validates and delegates, one call each.
@Controller()
export class IdentityController {
  constructor(private readonly service: IdentityService) {}

  @Post("auth/passkey/options")
  @Public()
  options(@Body(new ZodValidationPipe(passkeyOptionsRequestSchema)) body: PasskeyOptionsRequest): Promise<PasskeyOptionsResult> {
    return this.service.createOptions(body);
  }

  @Post("auth/passkey/verify")
  @Public()
  verify(
    @Body(new ZodValidationPipe(passkeyVerifyRequestSchema)) body: PasskeyVerifyRequest,
  ): Promise<PasskeyVerifyResult> {
    return this.service.verifyPasskey(body);
  }

  // @SkipTenantContext() — session-authenticated (AuthGuard requires a real
  // access token) but genuinely tenant-less: managing passkeys happens
  // before any workspace exists, so WorkspaceGuard never populates
  // req.tenant here, and TenantContextInterceptor must not fail-closed on
  // that the way it does for every other private route.
  @Get("me/passkeys")
  @SkipTenantContext()
  list(@Req() req: AuthenticatedRequest) {
    return this.service.listPasskeys(req.auth!.sub);
  }

  @Patch("me/passkeys/:id")
  @SkipTenantContext()
  rename(
    @Req() req: AuthenticatedRequest,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(passkeyRenameRequestSchema)) body: PasskeyRenameRequest,
  ): Promise<void> {
    return this.service.renamePasskey(req.auth!.sub, id, body.device_label);
  }

  @Delete("me/passkeys/:id")
  @SkipTenantContext()
  revoke(@Req() req: AuthenticatedRequest, @Param("id") id: string): Promise<void> {
    return this.service.revokePasskey(req.auth!.sub, id);
  }
}

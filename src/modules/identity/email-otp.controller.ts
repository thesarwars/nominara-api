import { Body, Controller, HttpCode, Post, Req, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import type { AuthenticatedRequest } from "../../api/guards/auth.guard.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Public } from "../../api/decorators/public.decorator.js";
import { SkipTenantContext } from "../../api/decorators/skip-tenant-context.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { SessionService } from "./session.service.js";
import { setAuthCookies } from "../../lib/auth/cookies.js";
import {
  emailOtpRequestResponseSchema,
  emailOtpRequestSchema,
  emailOtpVerifyRequestSchema,
  type EmailOtpRequest,
  type EmailOtpRequestResponse,
  type EmailOtpVerifyRequest,
} from "./dto/index.js";
import { EmailOtpService } from "./email-otp.service.js";

// STORY-016 — thin HTTP surface only (coding-standards.md §1: a
// conditional here is a smell). Every branch (rate-limiting, timing
// uniformity, decoy hashing) lives in EmailOtpService; this file validates
// and delegates.
interface EmailOtpRequestReq extends AuthenticatedRequest {
  readonly id?: string | number;
  readonly ip?: string;
}

function requestIdOf(req: EmailOtpRequestReq): string {
  return req.id !== undefined ? String(req.id) : "";
}

@Controller()
export class EmailOtpController {
  constructor(
    private readonly service: EmailOtpService,
    private readonly sessions: SessionService,
  ) {}

  @Post("auth/otp/request")
  @Public()
  @SkipTenantContext()
  @ApiContract({ operationId: "requestEmailOtp", requestSchema: emailOtpRequestSchema, responseSchema: emailOtpRequestResponseSchema })
  request(
    @Body(new ZodValidationPipe(emailOtpRequestSchema)) body: EmailOtpRequest,
    @Req() req: EmailOtpRequestReq,
  ): Promise<EmailOtpRequestResponse> {
    return this.service.requestCode(body.email, req.ip ?? null, requestIdOf(req));
  }

  // D8 — void + Set-Cookie, HTTP 200, mirroring POST /auth/passkey/verify —
  // nothing about the account needs to cross the wire.
  @Post("auth/otp/verify")
  @Public()
  @SkipTenantContext()
  @HttpCode(200)
  @ApiContract({ operationId: "verifyEmailOtp", requestSchema: emailOtpVerifyRequestSchema, voidResponse: true })
  async verify(
    @Body(new ZodValidationPipe(emailOtpVerifyRequestSchema)) body: EmailOtpVerifyRequest,
    @Req() req: EmailOtpRequestReq,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const tokens = await this.service.verifyCode(body.email, body.code, requestIdOf(req));
    await this.sessions.recordUserAgent(tokens.sid, req.headers?.["user-agent"]);
    setAuthCookies(reply, tokens);
  }
}

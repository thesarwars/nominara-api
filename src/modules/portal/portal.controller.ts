import { Body, Controller, HttpCode, Post, Req, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { portalSessionRequestSchema, portalSessionResponseSchema, type PortalSessionRequest, type PortalSessionResponse } from "../../../contracts/portal/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Public } from "../../api/decorators/public.decorator.js";
import { SkipTenantContext } from "../../api/decorators/skip-tenant-context.decorator.js";
import { RateLimitClass } from "../../api/rate-limit/route-class.js";
import { PORTAL_RESPONSE_HEADERS } from "../../api/interceptors/portal-context.interceptor.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { PORTAL_COOKIE_NAME } from "./portal-cookie.js";
import { PortalSessionService } from "./portal-session.service.js";

interface RequestLike {
  readonly ip?: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

// STORY-098 part B — api-specification.md §3 `POST /portal/session`: "token secret + password -> a short-lived scoped
// cookie (4 h)". Public (the visitor has no Nominara session) and tenant-less (the workspace is discovered by the
// service). §6/§12: 10/hour per address, via the `portal_session` class — the 5-failures-per-token lock is the
// service's, because it counts failures per token and not requests per address.
@Controller("portal")
export class PortalController {
  constructor(private readonly service: PortalSessionService) {}

  @Post("session")
  @HttpCode(200)
  @Public()
  @SkipTenantContext()
  @RateLimitClass("portal_session")
  @ApiContract({ operationId: "mintPortalSession", requestSchema: portalSessionRequestSchema, responseSchema: portalSessionResponseSchema })
  async createSession(
    @Body(new ZodValidationPipe(portalSessionRequestSchema)) body: PortalSessionRequest,
    @Req() req: RequestLike,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<PortalSessionResponse> {
    // FR-AGY-01q on the mint response too, and BEFORE the service runs so a refusal carries them as well.
    for (const [name, value] of Object.entries(PORTAL_RESPONSE_HEADERS)) reply.header(name, value);
    const ua = req.headers["user-agent"];
    const minted = await this.service.mint(body, { ip: req.ip ?? null, userAgent: Array.isArray(ua) ? (ua[0] ?? null) : (ua ?? null) });
    // `__Host-` demands Secure, Path=/ and NO Domain; HttpOnly + SameSite=Lax per the session flow.
    reply.setCookie(PORTAL_COOKIE_NAME, minted.cookie.value, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: minted.cookie.maxAgeSeconds });
    return minted.response;
  }
}

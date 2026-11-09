import { Body, Controller, HttpCode, Post, Req, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import {
  portalSessionCodeSentResponseSchema,
  portalSessionRequestSchema,
  portalSessionResponseSchema,
  portalSessionVerifyRequestSchema,
  type PortalSessionCodeSentResponse,
  type PortalSessionRequest,
  type PortalSessionResponse,
  type PortalSessionVerifyRequest,
} from "../../../contracts/portal/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Public } from "../../api/decorators/public.decorator.js";
import { SkipTenantContext } from "../../api/decorators/skip-tenant-context.decorator.js";
import { RateLimitClass } from "../../api/rate-limit/route-class.js";
import { PORTAL_RESPONSE_HEADERS } from "../../api/interceptors/portal-context.interceptor.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { PORTAL_COOKIE_NAME } from "./portal-cookie.js";
import { PortalSessionService, type MintedPortalSession, type RequestFacts } from "./portal-session.service.js";

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

  // Owner decision 71 (b): for a token with allowed email domains this answers 202 `{ code_sent: true }` and sets no cookie; the cookie
  // comes from POST /portal/session/verify. Every other token answers 200 with the cookie, as before.
  @Post("session")
  @HttpCode(200)
  @Public()
  @SkipTenantContext()
  @RateLimitClass("portal_session")
  @ApiContract({
    operationId: "mintPortalSession",
    requestSchema: portalSessionRequestSchema,
    responseSchema: z.union([portalSessionResponseSchema, portalSessionCodeSentResponseSchema]),
  })
  async createSession(
    @Body(new ZodValidationPipe(portalSessionRequestSchema)) body: PortalSessionRequest,
    @Req() req: RequestLike,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<PortalSessionResponse | PortalSessionCodeSentResponse> {
    // FR-AGY-01q on the mint response too, and BEFORE the service runs so a refusal carries them as well.
    for (const [name, value] of Object.entries(PORTAL_RESPONSE_HEADERS)) reply.header(name, value);
    const outcome = await this.service.mint(body, factsOf(req));
    if (outcome.kind === "code_sent") {
      reply.status(202);
      return { code_sent: true };
    }
    setSessionCookie(reply, outcome);
    return outcome.response;
  }

  // Owner decision 71 (b), step two. Same headers and cookie as the mint. The rate class is `auth` (30/min per address, burst 5), not
  // `portal_session` (10/hour, burst 2): a visitor who mistypes the code once would otherwise be refused for the next six minutes
  // after the code request and one try. Guessing is bounded elsewhere, and harder: 5 attempts per code, the token's own 5-failure
  // password lock, and 3 codes an hour per address and 10 per link.
  @Post("session/verify")
  @HttpCode(200)
  @Public()
  @SkipTenantContext()
  @RateLimitClass("auth")
  @ApiContract({ operationId: "verifyPortalSessionCode", requestSchema: portalSessionVerifyRequestSchema, responseSchema: portalSessionResponseSchema })
  async verifySession(
    @Body(new ZodValidationPipe(portalSessionVerifyRequestSchema)) body: PortalSessionVerifyRequest,
    @Req() req: RequestLike,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<PortalSessionResponse> {
    for (const [name, value] of Object.entries(PORTAL_RESPONSE_HEADERS)) reply.header(name, value);
    const minted = await this.service.verify(body, factsOf(req));
    setSessionCookie(reply, minted);
    return minted.response;
  }
}

function factsOf(req: RequestLike): RequestFacts {
  const ua = req.headers["user-agent"];
  return { ip: req.ip ?? null, userAgent: Array.isArray(ua) ? (ua[0] ?? null) : (ua ?? null) };
}

/** `__Host-` demands Secure, Path=/ and NO Domain; HttpOnly + SameSite=Lax per the session flow. */
function setSessionCookie(reply: FastifyReply, minted: MintedPortalSession): void {
  reply.setCookie(PORTAL_COOKIE_NAME, minted.cookie.value, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: minted.cookie.maxAgeSeconds });
}

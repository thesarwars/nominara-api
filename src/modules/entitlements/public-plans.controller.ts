import { Controller, Get, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { publicPlansResponseSchema, type PublicPlansResponse } from "../../../contracts/entitlements/public-plans.schema.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Public } from "../../api/decorators/public.decorator.js";
import { SkipTenantContext } from "../../api/decorators/skip-tenant-context.decorator.js";
import { RateLimitClass } from "../../api/rate-limit/route-class.js";
import { PublicPlansService } from "./public-plans.service.js";

// STORY-103 (API part) - the live-filtered plans snapshot for the pricing page build and the in-app plan comparison. Public: the
// marketing site has no session. Tenant-less: global data only. Rate class `public_plans` (per IP). Cacheable for a few minutes,
// because a plan change ships by rebuilding and the in-app comparison tolerates the same staleness.
@Controller("public/plans")
export class PublicPlansController {
  constructor(private readonly service: PublicPlansService) {}

  @Get()
  @Public()
  @SkipTenantContext()
  @RateLimitClass("public_plans")
  @ApiContract({ operationId: "getPublicPlans", responseSchema: publicPlansResponseSchema })
  async list(@Res({ passthrough: true }) reply: FastifyReply): Promise<PublicPlansResponse> {
    void reply.header("Cache-Control", "public, max-age=300");
    return await this.service.snapshot();
  }
}

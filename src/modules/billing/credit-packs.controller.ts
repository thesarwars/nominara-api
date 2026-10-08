import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import {
  creditPackKeyParamSchema,
  creditPackListQuerySchema,
  creditPackListResponseSchema,
  creditPackPurchaseRequestSchema,
  creditPackPurchaseResponseSchema,
  type CreditPack,
  type CreditPackListQuery,
  type CreditPackPurchaseRequest,
  type CreditPackPurchaseResponse,
} from "../../../contracts/billing/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { Idempotent } from "../../api/decorators/idempotent.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import type { Page } from "../../api/pagination/page.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { RateLimitClass } from "../../api/rate-limit/route-class.js";
import { CreditPacksService } from "./credit-packs.service.js";

// STORY-076a — api-specification.md §3: the catalog is `workspace:read`; the
// purchase is `billing:write`, idempotent (✚) and rate limited 5/hour per user
// (§12's `credit_pack_purchase` row).
@Controller("billing/credit-packs")
export class CreditPacksController {
  constructor(private readonly service: CreditPacksService) {}

  @Get()
  @RequirePermission("workspace:read")
  @ApiContract({ operationId: "listCreditPacks", querySchema: creditPackListQuerySchema, responseSchema: creditPackListResponseSchema, listOf: true })
  list(@Query(new ZodValidationPipe(creditPackListQuerySchema)) query: CreditPackListQuery): Promise<Page<CreditPack>> {
    return this.service.list(query);
  }

  @Post(":key/purchase")
  @HttpCode(200)
  @Idempotent()
  @RateLimitClass("credit_pack_purchase")
  @RequirePermission("billing:write")
  @Audit({ action: "billing.credit_pack.purchase_created", resourceType: "credit_purchase", resourceIdFrom: "response", responseIdPath: "purchase_id" })
  @ApiContract({
    operationId: "purchaseCreditPack",
    requestSchema: creditPackPurchaseRequestSchema,
    responseSchema: creditPackPurchaseResponseSchema,
  })
  purchase(
    @Param("key", new ZodValidationPipe(creditPackKeyParamSchema)) key: string,
    @Body(new ZodValidationPipe(creditPackPurchaseRequestSchema)) _body: CreditPackPurchaseRequest,
  ): Promise<CreditPackPurchaseResponse> {
    return this.service.purchase(key);
  }
}

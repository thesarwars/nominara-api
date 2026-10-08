import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Query } from "@nestjs/common";
import {
  addonChangeResponseSchema,
  addonCreateRequestSchema,
  addonKindSchema,
  addonListQuerySchema,
  addonListResponseSchema,
  type Addon,
  type AddonChangeResponse,
  type AddonCreateRequest,
  type AddonListQuery,
} from "../../../contracts/billing/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { Idempotent } from "../../api/decorators/idempotent.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import type { Page } from "../../api/pagination/page.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import type { AddonKind } from "../../lib/entitlements/resolution.js";
import { BillingAddonsService } from "./billing-addons.service.js";

// STORY-076b — api-specification.md §3: `/billing/addons` is billing:write
// (the list is billing:read). The two mutations answer 202 `pending`: they
// change Stripe, and the add-on lands when the webhook reconciles.
@Controller("billing/addons")
export class BillingAddonsController {
  constructor(private readonly service: BillingAddonsService) {}

  @Get()
  @RequirePermission("billing:read")
  @ApiContract({ operationId: "listAddons", querySchema: addonListQuerySchema, responseSchema: addonListResponseSchema, listOf: true })
  list(@Query(new ZodValidationPipe(addonListQuerySchema)) query: AddonListQuery): Promise<Page<Addon>> {
    return this.service.list(query);
  }

  @Post()
  @HttpCode(202)
  @Idempotent()
  @RequirePermission("billing:write")
  @Audit({ action: "billing.addon.change_requested", resourceType: "workspace", resourceIdFrom: "workspace" })
  @ApiContract({ operationId: "addAddon", requestSchema: addonCreateRequestSchema, responseSchema: addonChangeResponseSchema })
  add(
    @Body(new ZodValidationPipe(addonCreateRequestSchema)) body: AddonCreateRequest,
    // @Idempotent() has already refused a missing or malformed key.
    @Headers("idempotency-key") idempotencyKey: string,
  ): Promise<AddonChangeResponse> {
    return this.service.add(body, idempotencyKey);
  }

  @Delete(":kind")
  @HttpCode(202)
  @RequirePermission("billing:write")
  @Audit({ action: "billing.addon.removal_scheduled", resourceType: "workspace", resourceIdFrom: "workspace" })
  @ApiContract({ operationId: "removeAddon", paramsSchema: addonKindSchema, responseSchema: addonChangeResponseSchema })
  remove(@Param("kind", new ZodValidationPipe(addonKindSchema)) kind: AddonKind): Promise<AddonChangeResponse> {
    return this.service.remove(kind);
  }
}

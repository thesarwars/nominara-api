import { Controller, Get } from "@nestjs/common";
import { usageResponseSchema, type UsageResponse } from "../../../contracts/billing/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { BillingService } from "./billing.service.js";

// NEW-D-6 — `GET /v1/billing/usage`: the current period's non-credit tier caps.
@Controller("billing/usage")
export class BillingUsageController {
  constructor(private readonly service: BillingService) {}

  @Get()
  @RequirePermission("billing:read")
  @ApiContract({ operationId: "getBillingUsage", responseSchema: usageResponseSchema })
  usage(): Promise<UsageResponse> {
    return this.service.usage();
  }
}

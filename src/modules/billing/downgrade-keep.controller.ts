import { Body, Controller, Get, Put } from "@nestjs/common";
import { downgradeKeepRequestSchema, downgradeKeepResponseSchema, type DowngradeKeepRequest, type DowngradeKeepResponse } from "../../../contracts/billing/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { DowngradeKeepService } from "./downgrade-keep.service.js";

// STORY-077 D2 — the customer chooses what to keep before a downgrade's cut-over (owner approved 2026-10-20). The read is
// billing:read, the choice billing:write (owner and admin, no step-up, like the plan change itself). The choice moves no
// money and calls no provider, so it takes the ordinary `writes` rate class, not `plan_change`.
@Controller("billing/subscription/change/keep")
export class DowngradeKeepController {
  constructor(private readonly service: DowngradeKeepService) {}

  @Get()
  @RequirePermission("billing:read")
  @ApiContract({ operationId: "getDowngradeKeep", responseSchema: downgradeKeepResponseSchema })
  view(): Promise<DowngradeKeepResponse> {
    return this.service.view();
  }

  @Put()
  @RequirePermission("billing:write")
  @Audit({ action: "billing.plan_change.keep_chosen", resourceType: "workspace", resourceIdFrom: "workspace" })
  @ApiContract({ operationId: "setDowngradeKeep", requestSchema: downgradeKeepRequestSchema, responseSchema: downgradeKeepResponseSchema })
  choose(@Body(new ZodValidationPipe(downgradeKeepRequestSchema)) body: DowngradeKeepRequest): Promise<DowngradeKeepResponse> {
    return this.service.choose(body);
  }
}

import { Controller, Get } from "@nestjs/common";
import { retentionPurgeResponseSchema, type RetentionPurgeResponse } from "../../../contracts/billing/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { BillingService } from "./billing.service.js";

// STORY-096 AC3 (owner decision 100(h)) - `GET /v1/billing/retention-purge`: what the first purge of a pending retention-shortening deferral will remove, per
// project (the notice email's content, readable from Settings). billing:read is owner and admin. Separate from the stream that adds the full-data export.
@Controller("billing/retention-purge")
export class BillingRetentionPurgeController {
  constructor(private readonly service: BillingService) {}

  @Get()
  @RequirePermission("billing:read")
  @ApiContract({ operationId: "getRetentionPurge", responseSchema: retentionPurgeResponseSchema })
  retentionPurge(): Promise<RetentionPurgeResponse> {
    return this.service.retentionPurge();
  }
}

import { Controller, Get, Query } from "@nestjs/common";
import {
  accessGrantListQuerySchema,
  accessGrantListResponseSchema,
  type AccessGrant,
  type AccessGrantListQuery,
} from "../../../contracts/trust/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import type { Page } from "../../api/pagination/page.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { SupportGrantsService } from "./support-grants.service.js";

// NEW-D-5 — api-specification.md §3 `GET /trust/access-grants` (workspace:read).
// Read-only by construction: grants are issued and revoked by the ops CLI.
@Controller("trust")
export class TrustController {
  constructor(private readonly grants: SupportGrantsService) {}

  @Get("access-grants")
  @RequirePermission("workspace:read")
  @ApiContract({ operationId: "listAccessGrants", listOf: true, querySchema: accessGrantListQuerySchema, responseSchema: accessGrantListResponseSchema })
  list(@Query(new ZodValidationPipe(accessGrantListQuerySchema)) query: AccessGrantListQuery): Promise<Page<AccessGrant>> {
    return this.grants.list(query);
  }
}

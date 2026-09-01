import { Controller, Get, Req } from "@nestjs/common";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import type { WorkspaceScopedRequest } from "../../api/guards/workspace.guard.js";
import { resolvedEntitlementsResponseSchema, type ResolvedEntitlementsResponse } from "./dto/index.js";
import { EntitlementsService } from "./entitlements.service.js";

// STORY-069 AC5 and AC12 — api-specification.md §"Billing, entitlements &
// credits": `GET /billing/entitlements`, `workspace:read`, "**Resolved**
// effective entitlements (plan + add-ons + overrides) with
// `entitlement_version`. The client renders every limit and gate from this one
// payload."
//
// `workspace:read` RATHER THAN `billing:read`, per the reference. The two
// differ in the permission matrix: billing:read is owner/admin only, while
// workspace:read reaches every role including viewer. That is the correct
// reading — this is not billing data, it is what the whole interface renders
// its limits and disabled states from, and a viewer whose UI cannot resolve
// entitlements would render controls the server will refuse.
//
// ONE ENDPOINT, EVERY KEY. §1's opening: "No limit, price, or credit cost may
// be hardcoded in application code, in UI markup, or in marketing markup — all
// of it renders from GET /billing/entitlements or from a build-time snapshot
// of the same data." A client that has to make a second call to render a limit
// will eventually render it from a constant instead, which is what AC10
// forbids.
@Controller("billing")
export class EntitlementsController {
  constructor(private readonly service: EntitlementsService) {}

  @Get("entitlements")
  @RequirePermission("workspace:read")
  @ApiContract({
    operationId: "getResolvedEntitlements",
    responseSchema: resolvedEntitlementsResponseSchema,
  })
  async resolved(@Req() req: WorkspaceScopedRequest): Promise<ResolvedEntitlementsResponse> {
    // TenantContextInterceptor has already run by the time a handler executes,
    // so `tenant` is set for every non-@SkipTenantContext route.
    return await this.service.resolve(req.tenant!.workspaceId, req.entitlementVersion);
  }
}

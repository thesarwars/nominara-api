import { Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import {
  displacementDismissalResponseSchema,
  displacementFeedQuerySchema,
  displacementFeedResponseSchema,
  recoveryPlanResponseSchema,
  type RecoveryPlanResponse,
  type DisplacementDismissalResponse,
  type DisplacementFeedQuery,
  type DisplacementItem,
} from "../../../contracts/analytics/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { Idempotent } from "../../api/decorators/idempotent.decorator.js";
import { ProjectParam } from "../../api/decorators/project-param.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ScopedByQuery } from "../../api/decorators/scoped-by-query.decorator.js";
import type { Page } from "../../api/pagination/page.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { DisplacementService } from "./displacement.service.js";

// NEW-C-5 — `GET /projects/{id}/displacements` (`api-specification.md` §3, `tracking:read`),
// plus dismiss and restore. The spec names no permission for the two writes: `task:create` is
// PROPOSED (they decide what work a team does about a loss) and is raised with the owner.
// Both are `@ScopedByQuery()`: the id is a displacement, not a project, and the service checks
// the project scope itself (403 outside it).
@Controller()
export class DisplacementController {
  constructor(private readonly service: DisplacementService) {}

  @Get("projects/:id/displacements")
  @RequirePermission("tracking:read")
  @ProjectParam("id")
  @ApiContract({
    operationId: "listProjectDisplacements",
    querySchema: displacementFeedQuerySchema,
    responseSchema: displacementFeedResponseSchema,
    listOf: true,
  })
  feed(
    @Param("id") projectId: string,
    @Query(new ZodValidationPipe(displacementFeedQuerySchema)) query: DisplacementFeedQuery,
  ): Promise<Page<DisplacementItem>> {
    return this.service.feed(projectId, query);
  }

  @Post("displacements/:id/dismiss")
  @HttpCode(200)
  @RequirePermission("task:create")
  @ScopedByQuery()
  @Audit({ action: "displacement.dismissed", resourceType: "displacement" })
  @ApiContract({ operationId: "dismissDisplacement", responseSchema: displacementDismissalResponseSchema })
  dismiss(@Param("id") id: string): Promise<DisplacementDismissalResponse> {
    return this.service.dismiss(id);
  }

  @Post("displacements/:id/restore")
  @HttpCode(200)
  @RequirePermission("task:create")
  @ScopedByQuery()
  @Audit({ action: "displacement.restored", resourceType: "displacement" })
  @ApiContract({ operationId: "restoreDisplacement", responseSchema: displacementDismissalResponseSchema })
  restore(@Param("id") id: string): Promise<DisplacementDismissalResponse> {
    return this.service.restore(id);
  }

  // NEW-C-6 - `POST /displacements/{id}/recovery-plan`. Writes tasks, so `task:create`; `Idempotency-Key` is
  // enforced (a replay returns the stored response), and the fingerprint makes even a new key a no-op.
  @Post("displacements/:id/recovery-plan")
  @HttpCode(201)
  @Idempotent()
  @RequirePermission("task:create")
  @ScopedByQuery()
  @Audit({ action: "displacement.recovery_planned", resourceType: "displacement" })
  @ApiContract({ operationId: "createDisplacementRecoveryPlan", responseSchema: recoveryPlanResponseSchema })
  recoveryPlan(@Param("id") id: string): Promise<RecoveryPlanResponse> {
    return this.service.recoveryPlan(id);
  }
}

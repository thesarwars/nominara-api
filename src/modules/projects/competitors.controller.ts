import { Body, Controller, Delete, HttpCode, Param, Post, Req } from "@nestjs/common";
import {
  trackCompetitorRequestSchema,
  trackCompetitorResponseSchema,
  type TrackCompetitorRequest,
  type TrackCompetitorResponse,
} from "../../../contracts/projects/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { ProjectParam } from "../../api/decorators/project-param.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import type { RbacScopedRequest } from "../../api/guards/rbac.guard.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { CompetitorTrackingService } from "./competitor-tracking.service.js";

// NEW-C-2 — `POST|DELETE /projects/{id}/competitors`. `project:update`, both
// audited: changing the tracked set changes the meaning of every
// share-of-voice number after it. The cap is enforced in the service rather
// than by `@RequireEntitlement`, so a re-add of a name already tracked is a
// 409 and not a misleading entitlement refusal at the ceiling.
@Controller("projects/:id/competitors")
export class CompetitorsController {
  constructor(private readonly tracking: CompetitorTrackingService) {}

  @Post()
  @HttpCode(201)
  @RequirePermission("project:update")
  @ProjectParam("id")
  @Audit({ action: "competitor.tracked", resourceType: "entity", resourceIdFrom: "response" })
  @ApiContract({
    operationId: "trackProjectCompetitor",
    requestSchema: trackCompetitorRequestSchema,
    responseSchema: trackCompetitorResponseSchema,
  })
  track(
    @Req() req: RbacScopedRequest,
    @Param("id") projectId: string,
    @Body(new ZodValidationPipe(trackCompetitorRequestSchema)) body: TrackCompetitorRequest,
  ): Promise<TrackCompetitorResponse> {
    return this.tracking.track(req.tenant!.workspaceId, req.tenant!.actorId, projectId, body);
  }

  @Delete(":competitorId")
  @HttpCode(204)
  @RequirePermission("project:update")
  @ProjectParam("id")
  @Audit({ action: "competitor.untracked", resourceType: "competitor", resourceIdFrom: "params", paramName: "competitorId" })
  @ApiContract({ operationId: "untrackProjectCompetitor", voidResponse: true })
  untrack(
    @Req() req: RbacScopedRequest,
    @Param("id") projectId: string,
    @Param("competitorId") competitorId: string,
  ): Promise<void> {
    return this.tracking.untrack(req.tenant!.workspaceId, req.tenant!.actorId, projectId, competitorId);
  }
}

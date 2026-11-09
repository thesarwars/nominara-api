import { Body, Controller, Get, HttpCode, Param, Put, Req } from "@nestjs/common";
import {
  getProjectEnginesParamsSchema,
  getProjectEnginesResponseSchema,
  type GetProjectEnginesParams,
  type GetProjectEnginesResponse,
  updateProjectEnginesParamsSchema,
  updateProjectEnginesRequestSchema,
  updateProjectEnginesResponseSchema,
  type UpdateProjectEnginesParams,
  type UpdateProjectEnginesRequest,
  type UpdateProjectEnginesResponse,
} from "../../../contracts/projects/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { ProjectParam } from "../../api/decorators/project-param.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import type { RbacScopedRequest } from "../../api/guards/rbac.guard.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { ProjectEnginesService } from "./project-engines.service.js";

// `PUT /projects/{id}/engines` — project:update. Audited: a weight moves the
// blended Visibility Score and a disabled engine stops being captured, so a
// change here changes the meaning of every number after it.
@Controller("projects/:id/engines")
export class ProjectEnginesController {
  constructor(private readonly engines: ProjectEnginesService) {}

  // `GET` — the saved overrides plus the effective set. The PUT's permission: whoever may change the engines may read what they are.
  @Get()
  @RequirePermission("project:update")
  @ProjectParam("id")
  @ApiContract({ operationId: "getProjectEngines", paramsSchema: getProjectEnginesParamsSchema, responseSchema: getProjectEnginesResponseSchema })
  read(
    @Req() req: RbacScopedRequest,
    @Param(new ZodValidationPipe(getProjectEnginesParamsSchema)) { id: projectId }: GetProjectEnginesParams,
  ): Promise<GetProjectEnginesResponse> {
    return this.engines.read(req.tenant!.workspaceId, projectId);
  }

  @Put()
  @HttpCode(200)
  @RequirePermission("project:update")
  @ProjectParam("id")
  @Audit({ action: "project.engines_updated", resourceType: "project" })
  @ApiContract({
    operationId: "updateProjectEngines",
    paramsSchema: updateProjectEnginesParamsSchema,
    requestSchema: updateProjectEnginesRequestSchema,
    responseSchema: updateProjectEnginesResponseSchema,
  })
  update(
    @Req() req: RbacScopedRequest,
    @Param(new ZodValidationPipe(updateProjectEnginesParamsSchema)) { id: projectId }: UpdateProjectEnginesParams,
    @Body(new ZodValidationPipe(updateProjectEnginesRequestSchema)) body: UpdateProjectEnginesRequest,
  ): Promise<UpdateProjectEnginesResponse> {
    return this.engines.update(req.tenant!.workspaceId, projectId, body);
  }
}

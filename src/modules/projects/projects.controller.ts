import { Body, Controller, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import {
  confirmDiscoveryRequestSchema,
  createProjectRequestSchema,
  createProjectResponseSchema,
  discoveryResponseSchema,
  type CreateProjectRequest,
  type ConfirmDiscoveryRequest,
  type CreateProjectResponse,
  type DiscoveryResponse,
} from "../../../contracts/projects/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Idempotent } from "../../api/decorators/idempotent.decorator.js";
import { RequireEntitlement } from "../../api/decorators/require-entitlement.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import type { RbacScopedRequest } from "../../api/guards/rbac.guard.js";
import { ProjectsService } from "./projects.service.js";

// STORY-043 — api-specification.md §4. A controller resolves the request,
// calls one service method, and returns (coding-standards.md §1).
@Controller("projects")
export class ProjectsController {
  constructor(private readonly service: ProjectsService) {}

  // 202, not 201 (§4.4): the row exists and is readable, but the resource is
  // not in its final state — discovery is still running behind it.
  @Post()
  @HttpCode(202)
  @Idempotent()
  @RequirePermission("project:create")
  // AC17 — the project-count entitlement, refusing with the structural-limit
  // failure naming the limit and the current count. The guard already does
  // exactly that, so this is a decorator rather than a check in the service.
  @RequireEntitlement("projects.max")
  @Audit({ action: "project.created", resourceType: "project", resourceIdFrom: "response" })
  @ApiContract({
    operationId: "createProject",
    requestSchema: createProjectRequestSchema,
    responseSchema: createProjectResponseSchema,
  })
  create(
    @Req() req: RbacScopedRequest,
    @Body(new ZodValidationPipe(createProjectRequestSchema)) body: CreateProjectRequest,
  ): Promise<CreateProjectResponse> {
    return this.service.create(req.tenant!.workspaceId, req.tenant!.actorId, body, req.entitlementVersion);
  }

  // §4.5 — polled after creation. A plain read: no @Idempotent (nothing is
  // created), and `project:read` rather than `project:create`, because a
  // viewer watching onboarding must be able to see discovery arrive.
  @Get(":id/discovery")
  @RequirePermission("project:read")
  @ApiContract({ operationId: "getProjectDiscovery", responseSchema: discoveryResponseSchema })
  discovery(@Param("id") id: string): Promise<DiscoveryResponse> {
    return this.service.discoveryFor(id);
  }

  // §3's route table: `project:update`, "accept or override discovered fields
  // and proposed competitors". Audited because it changes what counts as a
  // mention, and therefore the meaning of every subsequent number (AC8).
  @Post(":id/discovery/confirm")
  @HttpCode(200)
  @RequirePermission("project:update")
  @Audit({ action: "project.discovery_confirmed", resourceType: "project" })
  @ApiContract({
    operationId: "confirmProjectDiscovery",
    requestSchema: confirmDiscoveryRequestSchema,
    responseSchema: discoveryResponseSchema,
  })
  confirmDiscovery(
    @Req() req: RbacScopedRequest,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(confirmDiscoveryRequestSchema)) body: ConfirmDiscoveryRequest,
  ): Promise<DiscoveryResponse> {
    return this.service.confirmDiscovery(req.tenant!.workspaceId, id, body, req.entitlementVersion);
  }
}

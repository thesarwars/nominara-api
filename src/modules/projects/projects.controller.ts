import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import {
  confirmDiscoveryRequestSchema,
  createProjectRequestSchema,
  projectListResponseSchema,
  startVerificationRequestSchema,
  verificationStateSchema,
  verificationStatusResponseSchema,
  createProjectResponseSchema,
  discoveryResponseSchema,
  type CreateProjectRequest,
  type ConfirmDiscoveryRequest,
  type CreateProjectResponse,
  type ProjectListItem,
  type DiscoveryResponse,
  type StartVerificationRequest,
  type VerificationState,
  type VerificationStatusResponse,
} from "../../../contracts/projects/index.js";
import { DomainVerificationService } from "./domain-verification.service.js";
import { paginationRequestSchema, type PaginationRequest } from "../../../contracts/common/pagination.schema.js";
import type { Page } from "../../api/pagination/page.js";
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
  constructor(
    private readonly service: ProjectsService,
    private readonly verification: DomainVerificationService,
  ) {}

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

  // §3's route table: `POST /projects/{id}/domain-verification` · `/check`,
  // both `project:update`. AC10 — every state change is audited, because
  // verification decides how much of a site we may look at.
  @Post(":id/domain-verification")
  @HttpCode(200)
  @RequirePermission("project:update")
  @Audit({ action: "project.domain_verification_started", resourceType: "project" })
  @ApiContract({
    operationId: "startDomainVerification",
    requestSchema: startVerificationRequestSchema,
    responseSchema: verificationStateSchema,
  })
  startVerification(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(startVerificationRequestSchema)) body: StartVerificationRequest,
  ): Promise<VerificationState> {
    return this.verification.start(id, body.method);
  }

  @Post(":id/domain-verification/check")
  @HttpCode(200)
  @RequirePermission("project:update")
  @Audit({ action: "project.domain_verification_checked", resourceType: "project" })
  @ApiContract({
    operationId: "checkDomainVerification",
    requestSchema: startVerificationRequestSchema,
    responseSchema: verificationStateSchema,
  })
  checkVerification(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(startVerificationRequestSchema)) body: StartVerificationRequest,
  ): Promise<VerificationState> {
    return this.verification.check(id, body.method);
  }

  // Not in §3's table, and needed: without it a client that has started two
  // methods has no way to ask which of them currently holds, and no way to
  // render the audit scope it implies.
  @Get(":id/domain-verification")
  @RequirePermission("project:read")
  @ApiContract({ operationId: "getDomainVerification", responseSchema: verificationStatusResponseSchema })
  verificationStatus(@Param("id") id: string): Promise<VerificationStatusResponse> {
    return this.verification.status(id);
  }

  // §3: `GET /projects` — "workspace matrix". `project:read`, not
  // `project:create`: a viewer must be able to see the list.
  @Get()
  @RequirePermission("project:read")
  @ApiContract({
    operationId: "listProjects",
    querySchema: paginationRequestSchema,
    responseSchema: projectListResponseSchema,
    listOf: true,
  })
  list(
    @Query(new ZodValidationPipe(paginationRequestSchema)) pagination: PaginationRequest,
  ): Promise<Page<ProjectListItem>> {
    return this.service.list(pagination);
  }
}

import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, Res, UnauthorizedException } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { paginationRequestSchema, type PaginationRequest } from "../../../contracts/common/pagination.schema.js";
import type { Page } from "../../api/pagination/page.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { entityTagFor, formatEntityTag } from "../../api/etag/entity-tag.js";
import { parseIfMatch } from "../../api/etag/if-match.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ScopedByQuery } from "../../api/decorators/scoped-by-query.decorator.js";
import { SkipTenantContext } from "../../api/decorators/skip-tenant-context.decorator.js";
import type { AuditableRequest } from "../../api/interceptors/audit.interceptor.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { REFRESH_COOKIE_NAME, setAuthCookies } from "../../lib/auth/cookies.js";
import { assertMatchesTenant, assertPathIsTokenWorkspace } from "../../tenancy/assert-matches-tenant.js";
import type { RbacScopedRequest } from "../../api/guards/rbac.guard.js";
import {
  acceptInvitationParamsSchema,
  acceptInvitationRequestSchema,
  createInvitationRequestSchema,
  createWorkspaceRequestSchema,
  deleteWorkspaceParamsSchema,
  deleteWorkspaceRequestSchema,
  type DeleteWorkspaceParams,
  type DeleteWorkspaceRequest,
  invitationResponseSchema,
  invitationRevokeParamsSchema,
  workspaceDetailResponseSchema,
  type InvitationRevokeParams,
  type WorkspaceDetailResponse,
  memberResponseSchema,
  updateMemberRoleRequestSchema,
  updateWorkspaceRequestSchema,
  workspaceListResponseSchema,
  workspaceResponseSchema,
  workspaceSummaryResponseSchema,
  type WorkspaceSummaryResponse,
  type AcceptInvitationParams,
  type AcceptInvitationRequest,
  type CreateInvitationRequest,
  type CreateWorkspaceRequest,
  type InvitationResponse,
  type MemberResponse,
  type UpdateMemberRoleRequest,
  type UpdateWorkspaceRequest,
  type WorkspaceListItemWithRelationship,
  type WorkspaceResponse,
} from "./dto/index.js";
import { actionItemListResponseSchema, type ActionItem } from "../tasks/dto/index.js";
import { InvitationsService } from "./invitations.service.js";
import { TasksService } from "../tasks/tasks.service.js";
import { WorkspacesService, type AuditRequestMeta } from "./workspaces.service.js";
import { WorkspaceSummaryService } from "./workspace-summary.service.js";

// STORY-021 — thin HTTP surface only (coding-standards.md §1: a conditional
// here is a smell). Flattened @Controller() (no path prefix) because
// PATCH/DELETE /members/{id} is not nested under /workspaces.
function firstHeaderValue(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function auditMeta(req: AuditableRequest): AuditRequestMeta {
  return {
    ip: req.ip ?? null,
    ua: firstHeaderValue(req.headers["user-agent"]),
    requestId: req.id !== undefined ? String(req.id) : "",
  };
}

@Controller()
export class WorkspacesController {
  constructor(
    private readonly service: WorkspacesService,
    private readonly invitations: InvitationsService,
    private readonly tasks: TasksService,
    private readonly summaries: WorkspaceSummaryService,
  ) {}

  @Post("workspaces")
  @SkipTenantContext()
  @ApiContract({
    operationId: "createWorkspace",
    requestSchema: createWorkspaceRequestSchema,
    responseSchema: workspaceResponseSchema,
    emitsEntityTag: true,
  })
  async create(
    @Req() req: AuditableRequest,
    @Body(new ZodValidationPipe(createWorkspaceRequestSchema)) body: CreateWorkspaceRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<WorkspaceResponse> {
    const workspace = await this.service.create(req.auth!.sub, body, auditMeta(req));
    // The only route that hands a caller their FIRST tag for a workspace:
    // there is no item-level GET /workspaces/{id} yet (a STORY-021 gap, not
    // something this task invents), so without this a client would have no
    // way to obtain a tag for the PATCH below except `If-Match: *`.
    reply.header("ETag", formatEntityTag(entityTagFor(workspace)));
    return workspace;
  }

  @Get("workspaces")
  @SkipTenantContext()
  @ApiContract({
    operationId: "listWorkspaces",
    querySchema: paginationRequestSchema,
    responseSchema: workspaceListResponseSchema,
    listOf: true,
  })
  list(
    @Req() req: AuditableRequest,
    @Query(new ZodValidationPipe(paginationRequestSchema)) pagination: PaginationRequest,
  ): Promise<Page<WorkspaceListItemWithRelationship>> {
    return this.service.listForActor(req.auth!.sub, pagination);
  }

  @Patch("workspaces/:id")
  @RequirePermission("workspace:update")
  @Audit({ action: "workspace.updated", resourceType: "workspace" })
  @ApiContract({
    operationId: "updateWorkspace",
    requestSchema: updateWorkspaceRequestSchema,
    responseSchema: workspaceResponseSchema,
    requiresIfMatch: true,
    emitsEntityTag: true,
  })
  async update(
    @Req() req: RbacScopedRequest,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateWorkspaceRequestSchema)) body: UpdateWorkspaceRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<WorkspaceResponse> {
    assertMatchesTenant(id, req.tenant!.workspaceId);
    // Parsed here, ENFORCED in the service — the comparison has to happen
    // under the same row lock as the write or it is check-then-act.
    const workspace = await this.service.update(id, body, parseIfMatch(firstHeaderValue(req.headers?.["if-match"]) ?? undefined));
    reply.header("ETag", formatEntityTag(entityTagFor(workspace)));
    return workspace;
  }

  // NEW-A-12 — api-specification.md §3: "GET /workspaces/{id} — workspace:read".
  @Get("workspaces/:id")
  @RequirePermission("workspace:read")
  @ApiContract({ operationId: "getWorkspace", responseSchema: workspaceDetailResponseSchema, emitsEntityTag: true })
  async getOne(
    @Req() req: RbacScopedRequest,
    @Param("id") id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<WorkspaceDetailResponse> {
    assertPathIsTokenWorkspace(id, req.tenant!.workspaceId);
    const { detail, entityTag } = await this.service.getDetail(id);
    reply.header("ETag", formatEntityTag(entityTagFor(entityTag)));
    return detail;
  }

  // api-specification.md section 3: `DELETE /workspaces/{id}` - `workspace:delete` (owner, step-up), 30-day grace. The permission matrix
  // puts the step-up on the permission, so the guard answers 401 `step_up_required` before this runs.
  @Delete("workspaces/:id")
  @HttpCode(202)
  @RequirePermission("workspace:delete")
  @Audit({ action: "workspace.deletion_scheduled", resourceType: "workspace", severity: "critical" })
  @ApiContract({
    operationId: "deleteWorkspace",
    paramsSchema: deleteWorkspaceParamsSchema,
    requestSchema: deleteWorkspaceRequestSchema,
    responseSchema: workspaceDetailResponseSchema,
  })
  requestDeletion(
    @Req() req: RbacScopedRequest,
    @Param(new ZodValidationPipe(deleteWorkspaceParamsSchema)) { id }: DeleteWorkspaceParams,
    @Body(new ZodValidationPipe(deleteWorkspaceRequestSchema)) body: DeleteWorkspaceRequest,
  ): Promise<WorkspaceDetailResponse> {
    assertPathIsTokenWorkspace(id, req.tenant!.workspaceId);
    return this.service.requestDeletion(id, body.confirm_slug);
  }

  @Post("workspaces/:id/switch")
  @SkipTenantContext()
  @HttpCode(200)
  @ApiContract({ operationId: "switchWorkspace", voidResponse: true })
  async switchWorkspace(
    @Req() req: AuditableRequest,
    @Param("id") id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const rawRefreshToken = req.cookies?.[REFRESH_COOKIE_NAME];
    if (!rawRefreshToken) {
      throw new UnauthorizedException("missing refresh token cookie");
    }
    const { accessToken, csrfToken } = await this.service.switchTo(req.auth!.sub, req.auth!.sid, id, auditMeta(req));
    setAuthCookies(reply, { accessToken, refreshToken: rawRefreshToken, csrfToken });
  }

  @Get("workspaces/:id/members")
  @RequirePermission("workspace:read")
  @ApiContract({
    operationId: "listWorkspaceMembers",
    querySchema: paginationRequestSchema,
    responseSchema: z.array(memberResponseSchema),
    listOf: true,
  })
  listMembers(
    @Req() req: RbacScopedRequest,
    @Param("id") id: string,
    @Query(new ZodValidationPipe(paginationRequestSchema)) pagination: PaginationRequest,
  ): Promise<Page<MemberResponse>> {
    assertPathIsTokenWorkspace(id, req.tenant!.workspaceId);
    return this.service.listMembers(pagination);
  }

  @Patch("members/:id")
  @RequirePermission("member:update_role")
  @Audit({ action: "member.role_changed", resourceType: "workspace_member" })
  @ApiContract({ operationId: "updateMemberRole", requestSchema: updateMemberRoleRequestSchema, responseSchema: memberResponseSchema })
  updateMemberRole(
    @Req() req: RbacScopedRequest,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateMemberRoleRequestSchema)) body: UpdateMemberRoleRequest,
  ): Promise<MemberResponse> {
    return this.service.updateMemberRole(req.tenant!.workspaceId, req.membership!.role, id, body);
  }

  @Delete("members/:id")
  @RequirePermission("member:remove")
  @Audit({ action: "member.removed", resourceType: "workspace_member" })
  @ApiContract({ operationId: "removeMember", voidResponse: true })
  removeMember(@Req() req: RbacScopedRequest, @Param("id") id: string): Promise<void> {
    return this.service.removeMemberById(req.tenant!.workspaceId, id);
  }

  @Post("workspaces/:id/invitations")
  @RequirePermission("member:invite")
  @Audit({ action: "member.invited", resourceType: "invitation", resourceIdFrom: "response" })
  @ApiContract({ operationId: "createInvitation", requestSchema: createInvitationRequestSchema, responseSchema: invitationResponseSchema })
  createInvitation(
    @Req() req: RbacScopedRequest,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(createInvitationRequestSchema)) body: CreateInvitationRequest,
  ): Promise<InvitationResponse> {
    assertMatchesTenant(id, req.tenant!.workspaceId);
    return this.invitations.create(id, req.tenant!.actorId, body);
  }

  @Get("workspaces/:id/invitations")
  @RequirePermission("member:invite")
  @ApiContract({
    operationId: "listInvitations",
    querySchema: paginationRequestSchema,
    responseSchema: z.array(invitationResponseSchema),
    listOf: true,
  })
  listInvitations(
    @Req() req: RbacScopedRequest,
    @Param("id") id: string,
    @Query(new ZodValidationPipe(paginationRequestSchema)) pagination: PaginationRequest,
  ): Promise<Page<InvitationResponse>> {
    assertMatchesTenant(id, req.tenant!.workspaceId);
    return this.invitations.list(id, pagination);
  }

  // NEW-A-12 — revoke a pending invitation. Same permission as creating one.
  @Delete("workspaces/:id/invitations/:invitationId")
  @RequirePermission("member:invite")
  @Audit({ action: "member.invitation_revoked", resourceType: "invitation", paramName: "invitationId" })
  @ApiContract({ operationId: "revokeInvitation", paramsSchema: invitationRevokeParamsSchema, voidResponse: true })
  revokeInvitation(
    @Req() req: RbacScopedRequest,
    @Param(new ZodValidationPipe(invitationRevokeParamsSchema)) { id, invitationId }: InvitationRevokeParams,
  ): Promise<void> {
    assertPathIsTokenWorkspace(id, req.tenant!.workspaceId);
    return this.invitations.revoke(id, invitationId);
  }

  // NEW-B-2 — api-specification.md §3: "GET /workspaces/{id}/summary —
  // project:read — Command Center matrix". `@ScopedByQuery()` for the reason
  // given on `listActionItems` below: the route names a workspace, and the
  // project scope is applied inside `ProjectsService.listForSummary`.
  // `assertMatchesTenant` first, so another workspace's id is refused.
  @Get("workspaces/:id/summary")
  @RequirePermission("project:read")
  @ScopedByQuery()
  @ApiContract({ operationId: "getWorkspaceSummary", responseSchema: workspaceSummaryResponseSchema })
  summary(@Req() req: RbacScopedRequest, @Param("id") id: string): Promise<WorkspaceSummaryResponse> {
    assertMatchesTenant(id, req.tenant!.workspaceId);
    return this.summaries.summary(id);
  }

  // STORY-169 (API step 2/3) — api-specification.md §3: "GET /workspaces/
  // {id}/summary · /action-items — project:read / task:read — Command
  // Center matrix; cross-project queue." Lives HERE, not on
  // TasksController: this controller already owns every other
  // `workspaces/:id/*` cross-resource route (members, invitations above),
  // flattened for exactly that reason (see the top-of-file comment);
  // TasksController's own `@Controller("tasks")` prefix cannot serve a
  // `workspaces/:id/...` path. `tasks` is TasksService's table
  // (coding-standards.md §1), so the query lives there and this method
  // only resolves the request, calls it, and returns.
  // STORY-169 review — `@ScopedByQuery()`: same reasoning as `ProjectsController
  // .list` — this route names a WORKSPACE, not a project, so `@ProjectParam()`
  // has nothing to point at, and `TasksService.listActionItems`'s own query
  // already narrows by `app.current_scope_projects()` (copied from
  // `ProjectsService.list` for exactly this reason). Without this, a
  // project-scoped manager or viewer was refused this route outright,
  // regardless of how many projects they were scoped to (FR-DASH-04 was not
  // actually served for that population — `rbac.guard.spec.ts`'s "STORY-169
  // review" scenarios reproduce it against this exact handler).
  @Get("workspaces/:id/action-items")
  @RequirePermission("task:read")
  @ScopedByQuery()
  @ApiContract({
    operationId: "listActionItems",
    querySchema: paginationRequestSchema,
    responseSchema: actionItemListResponseSchema,
    listOf: true,
  })
  listActionItems(
    @Req() req: RbacScopedRequest,
    @Param("id") id: string,
    @Query(new ZodValidationPipe(paginationRequestSchema)) pagination: PaginationRequest,
  ): Promise<Page<ActionItem>> {
    assertMatchesTenant(id, req.tenant!.workspaceId);
    return this.tasks.listActionItems(pagination);
  }

  @Post("workspaces/:id/invitations/accept")
  @SkipTenantContext()
  @HttpCode(200)
  @ApiContract({
    operationId: "acceptInvitation",
    paramsSchema: acceptInvitationParamsSchema,
    requestSchema: acceptInvitationRequestSchema,
    responseSchema: memberResponseSchema,
  })
  acceptInvitation(
    @Req() req: AuditableRequest,
    @Param(new ZodValidationPipe(acceptInvitationParamsSchema)) { id }: AcceptInvitationParams,
    @Body(new ZodValidationPipe(acceptInvitationRequestSchema)) body: AcceptInvitationRequest,
  ): Promise<MemberResponse> {
    return this.invitations.accept(id, req.auth!.sub, body.token, auditMeta(req));
  }
}

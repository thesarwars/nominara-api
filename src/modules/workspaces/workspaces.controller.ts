import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, Res, UnauthorizedException } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { entityTagFor, formatEntityTag } from "../../api/etag/entity-tag.js";
import { parseIfMatch } from "../../api/etag/if-match.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { SkipTenantContext } from "../../api/decorators/skip-tenant-context.decorator.js";
import type { AuditableRequest } from "../../api/interceptors/audit.interceptor.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { REFRESH_COOKIE_NAME, setAuthCookies } from "../../lib/auth/cookies.js";
import { assertMatchesTenant } from "../../tenancy/assert-matches-tenant.js";
import type { RbacScopedRequest } from "../../api/guards/rbac.guard.js";
import {
  acceptInvitationRequestSchema,
  createInvitationRequestSchema,
  createWorkspaceRequestSchema,
  invitationResponseSchema,
  memberResponseSchema,
  updateMemberRoleRequestSchema,
  updateWorkspaceRequestSchema,
  workspaceListResponseSchema,
  workspaceResponseSchema,
  type AcceptInvitationRequest,
  type CreateInvitationRequest,
  type CreateWorkspaceRequest,
  type InvitationResponse,
  type MemberResponse,
  type UpdateMemberRoleRequest,
  type UpdateWorkspaceRequest,
  type WorkspaceListResponse,
  type WorkspaceResponse,
} from "./dto/index.js";
import { InvitationsService } from "./invitations.service.js";
import { WorkspacesService, type AuditRequestMeta } from "./workspaces.service.js";

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
  @ApiContract({ operationId: "listWorkspaces", responseSchema: workspaceListResponseSchema })
  list(@Req() req: AuditableRequest): Promise<WorkspaceListResponse> {
    return this.service.listForActor(req.auth!.sub);
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

  @Post("workspaces/:id/switch")
  @SkipTenantContext()
  @HttpCode(200)
  @ApiContract({ operationId: "switchWorkspace" })
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
  @ApiContract({ operationId: "listWorkspaceMembers" })
  listMembers(@Req() req: RbacScopedRequest, @Param("id") id: string): Promise<MemberResponse[]> {
    assertMatchesTenant(id, req.tenant!.workspaceId);
    return this.service.listMembers();
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
  @ApiContract({ operationId: "removeMember" })
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
  @ApiContract({ operationId: "listInvitations" })
  listInvitations(@Req() req: RbacScopedRequest, @Param("id") id: string): Promise<InvitationResponse[]> {
    assertMatchesTenant(id, req.tenant!.workspaceId);
    return this.invitations.list(id);
  }

  @Post("workspaces/:id/invitations/accept")
  @SkipTenantContext()
  @HttpCode(200)
  @ApiContract({ operationId: "acceptInvitation", requestSchema: acceptInvitationRequestSchema, responseSchema: memberResponseSchema })
  acceptInvitation(
    @Req() req: AuditableRequest,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(acceptInvitationRequestSchema)) body: AcceptInvitationRequest,
  ): Promise<MemberResponse> {
    return this.invitations.accept(id, req.auth!.sub, body.token, auditMeta(req));
  }
}

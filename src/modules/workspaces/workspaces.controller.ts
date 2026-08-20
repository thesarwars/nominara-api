import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, Res, UnauthorizedException } from "@nestjs/common";
import type { FastifyReply } from "fastify";
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
  updateMemberRoleRequestSchema,
  updateWorkspaceRequestSchema,
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
  create(
    @Req() req: AuditableRequest,
    @Body(new ZodValidationPipe(createWorkspaceRequestSchema)) body: CreateWorkspaceRequest,
  ): Promise<WorkspaceResponse> {
    return this.service.create(req.auth!.sub, body, auditMeta(req));
  }

  @Get("workspaces")
  @SkipTenantContext()
  list(@Req() req: AuditableRequest): Promise<WorkspaceListResponse> {
    return this.service.listForActor(req.auth!.sub);
  }

  @Patch("workspaces/:id")
  @RequirePermission("workspace:update")
  @Audit({ action: "workspace.updated", resourceType: "workspace" })
  update(
    @Req() req: RbacScopedRequest,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateWorkspaceRequestSchema)) body: UpdateWorkspaceRequest,
  ): Promise<WorkspaceResponse> {
    assertMatchesTenant(id, req.tenant!.workspaceId);
    return this.service.update(id, body);
  }

  @Post("workspaces/:id/switch")
  @SkipTenantContext()
  @HttpCode(200)
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
  listMembers(@Req() req: RbacScopedRequest, @Param("id") id: string): Promise<MemberResponse[]> {
    assertMatchesTenant(id, req.tenant!.workspaceId);
    return this.service.listMembers();
  }

  @Patch("members/:id")
  @RequirePermission("member:update_role")
  @Audit({ action: "member.role_changed", resourceType: "workspace_member" })
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
  removeMember(@Req() req: RbacScopedRequest, @Param("id") id: string): Promise<void> {
    return this.service.removeMemberById(req.tenant!.workspaceId, id);
  }

  @Post("workspaces/:id/invitations")
  @RequirePermission("member:invite")
  @Audit({ action: "member.invited", resourceType: "invitation", resourceIdFrom: "response" })
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
  listInvitations(@Req() req: RbacScopedRequest, @Param("id") id: string): Promise<InvitationResponse[]> {
    assertMatchesTenant(id, req.tenant!.workspaceId);
    return this.invitations.list(id);
  }

  @Post("workspaces/:id/invitations/accept")
  @SkipTenantContext()
  @HttpCode(200)
  acceptInvitation(
    @Req() req: AuditableRequest,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(acceptInvitationRequestSchema)) body: AcceptInvitationRequest,
  ): Promise<MemberResponse> {
    return this.invitations.accept(id, req.auth!.sub, body.token, auditMeta(req));
  }
}

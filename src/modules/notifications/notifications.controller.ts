import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from "@nestjs/common";
import {
  markAllNotificationsReadResponseSchema,
  markNotificationReadResponseSchema,
  notificationListQuerySchema,
  notificationListResponseSchema,
  notificationPreferencesSchema,
  updateNotificationPreferencesRequestSchema,
  type MarkAllNotificationsReadResponse,
  type MarkNotificationReadResponse,
  type Notification,
  type NotificationListQuery,
  type NotificationListResponse,
  type NotificationPreferences,
  type UpdateNotificationPreferencesRequest,
} from "../../../contracts/notifications/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ForbiddenError } from "../../api/errors/domain-errors.js";
import type { RbacScopedRequest } from "../../api/guards/rbac.guard.js";
import type { Page } from "../../api/pagination/page.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { assertMatchesTenant } from "../../tenancy/assert-matches-tenant.js";
import { NotificationsService, type Viewer } from "./notifications.service.js";

// STORY-068 — the inbox and the digest preference. A controller resolves the request, calls one service method and
// returns (coding-standards.md §1). `workspace:read`: every member has an inbox; what each sees is the service's.
// The routes are the workspace's (`workspaces/:id/*`, the URL id checked against the token's workspace), and every one
// acts for THE CALLER: a person, never an API key (an API key has no inbox and no digest).

function viewerOf(req: RbacScopedRequest): Viewer {
  const membership = req.membership;
  if (req.authMethod === "apiKey" || membership === undefined || req.tenant === undefined) throw new ForbiddenError({ message: "notifications belong to a member of the workspace", details: { required_permission: "workspace:read" } });
  return { userId: req.tenant.actorId, role: membership.role, projectScope: membership.projectScope };
}

@Controller()
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @Get("workspaces/:id/notifications")
  @RequirePermission("workspace:read")
  @ApiContract({ operationId: "listNotifications", querySchema: notificationListQuerySchema, responseSchema: notificationListResponseSchema, listOf: true })
  list(
    @Req() req: RbacScopedRequest,
    @Param("id") id: string,
    @Query(new ZodValidationPipe(notificationListQuerySchema)) query: NotificationListQuery,
  ): Promise<Page<Notification, NotificationListResponse>> {
    assertMatchesTenant(id, req.tenant!.workspaceId);
    return this.service.list(viewerOf(req), query);
  }

  @Post("workspaces/:id/notifications/read-all")
  @HttpCode(200)
  @RequirePermission("workspace:read")
  @Audit({ action: "notification.read_all", resourceType: "workspace", resourceIdFrom: "workspace" })
  @ApiContract({ operationId: "markAllNotificationsRead", responseSchema: markAllNotificationsReadResponseSchema })
  markAllRead(@Req() req: RbacScopedRequest, @Param("id") id: string): Promise<MarkAllNotificationsReadResponse> {
    assertMatchesTenant(id, req.tenant!.workspaceId);
    return this.service.markAllRead(viewerOf(req));
  }

  @Post("workspaces/:id/notifications/:notificationId/read")
  @HttpCode(200)
  @RequirePermission("workspace:read")
  @Audit({ action: "notification.read", resourceType: "notification", paramName: "notificationId" })
  @ApiContract({ operationId: "markNotificationRead", responseSchema: markNotificationReadResponseSchema })
  markRead(@Req() req: RbacScopedRequest, @Param("id") id: string, @Param("notificationId") notificationId: string): Promise<MarkNotificationReadResponse> {
    assertMatchesTenant(id, req.tenant!.workspaceId);
    return this.service.markRead(viewerOf(req), notificationId);
  }

  @Get("workspaces/:id/notification-preferences")
  @RequirePermission("workspace:read")
  @ApiContract({ operationId: "getNotificationPreferences", responseSchema: notificationPreferencesSchema })
  preferences(@Req() req: RbacScopedRequest, @Param("id") id: string): Promise<NotificationPreferences> {
    assertMatchesTenant(id, req.tenant!.workspaceId);
    return this.service.preferences(viewerOf(req));
  }

  @Patch("workspaces/:id/notification-preferences")
  @RequirePermission("workspace:read")
  @Audit({ action: "notification_preferences.updated", resourceType: "workspace", resourceIdFrom: "workspace" })
  @ApiContract({ operationId: "updateNotificationPreferences", requestSchema: updateNotificationPreferencesRequestSchema, responseSchema: notificationPreferencesSchema })
  updatePreferences(
    @Req() req: RbacScopedRequest,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateNotificationPreferencesRequestSchema)) body: UpdateNotificationPreferencesRequest,
  ): Promise<NotificationPreferences> {
    assertMatchesTenant(id, req.tenant!.workspaceId);
    return this.service.updatePreferences(viewerOf(req), body);
  }
}

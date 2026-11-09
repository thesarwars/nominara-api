import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import {
  attributionConfigSchema,
  attributionConfigResponseSchema,
  createAttributionConfigRequestSchema,
  type AttributionConfig,
  type AttributionConfigResponse,
  type CreateAttributionConfigRequest,
} from "../../../contracts/attribution/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { ProjectParam } from "../../api/decorators/project-param.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import type { RbacScopedRequest } from "../../api/guards/rbac.guard.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { AttributionConfigService } from "./attribution-config.service.js";

// STORY-113 - `/projects/{id}/attribution/config`. `workspace:update` on all three; the two writes also need a fresh step-up (in the
// service, as the ownership transfer does it). Credentials go in on POST and are never in any response.
@Controller("projects/:id/attribution/config")
export class AttributionConfigController {
  constructor(private readonly configs: AttributionConfigService) {}

  @Get()
  @RequirePermission("workspace:update")
  @ProjectParam("id")
  @ApiContract({ operationId: "getAttributionConfig", responseSchema: attributionConfigResponseSchema })
  get(@Req() req: RbacScopedRequest, @Param("id") projectId: string): Promise<AttributionConfigResponse> {
    return this.configs.get(req.tenant!.workspaceId, projectId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("workspace:update")
  @ProjectParam("id")
  @Audit({ action: "attribution.config_created", resourceType: "attribution_config", resourceIdFrom: "response" })
  @ApiContract({ operationId: "createAttributionConfig", requestSchema: createAttributionConfigRequestSchema, responseSchema: attributionConfigSchema })
  create(
    @Req() req: RbacScopedRequest,
    @Param("id") projectId: string,
    @Body(new ZodValidationPipe(createAttributionConfigRequestSchema)) body: CreateAttributionConfigRequest,
  ): Promise<AttributionConfig> {
    return this.configs.create(req.tenant!.workspaceId, req.tenant!.actorId, projectId, req.session?.lastStrongAuthAt ?? null, body);
  }

  @Delete()
  @HttpCode(204)
  @RequirePermission("workspace:update")
  @ProjectParam("id")
  @Audit({ action: "attribution.config_disconnected", resourceType: "project", resourceIdFrom: "params" })
  @ApiContract({ operationId: "disconnectAttributionConfig", voidResponse: true })
  disconnect(@Req() req: RbacScopedRequest, @Param("id") projectId: string): Promise<void> {
    return this.configs.disconnect(req.tenant!.workspaceId, projectId, req.session?.lastStrongAuthAt ?? null);
  }
}

import { Body, Controller, Delete, Get, HttpCode, Param, Post } from "@nestjs/common";
import { z } from "zod";
import {
  apiKeyListResponseSchema,
  apiKeySchema,
  createApiKeyRequestSchema,
  createdApiKeySchema,
  type ApiKey,
  type CreateApiKeyRequest,
  type CreatedApiKey,
} from "../../../contracts/workspaces/api-key.schema.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { RequireEntitlement } from "../../api/decorators/require-entitlement.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { ApiKeysService } from "./api-keys.service.js";

// NEW-D-4 — api-specification.md §3: `GET`/`POST`/`DELETE` `/api-keys`, all
// `apikey:create` (owner and admin, with a fresh step-up — permission-matrix.ts).
@Controller("api-keys")
export class ApiKeysController {
  constructor(private readonly service: ApiKeysService) {}

  @Get()
  @RequirePermission("apikey:create")
  @ApiContract({ operationId: "listApiKeys", responseSchema: apiKeyListResponseSchema })
  list(): Promise<ApiKey[]> {
    return this.service.list();
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("apikey:create")
  @RequireEntitlement("api.keys_max")
  @Audit({ action: "api_key.created", resourceType: "api_key", resourceIdFrom: "response", responseIdPath: "key.id", severity: "warning" })
  @ApiContract({ operationId: "createApiKey", requestSchema: createApiKeyRequestSchema, responseSchema: createdApiKeySchema })
  create(@Body(new ZodValidationPipe(createApiKeyRequestSchema)) body: CreateApiKeyRequest): Promise<CreatedApiKey> {
    return this.service.create(body);
  }

  @Delete(":id")
  @HttpCode(200)
  @RequirePermission("apikey:create")
  @Audit({ action: "api_key.revoked", resourceType: "api_key", severity: "notice" })
  @ApiContract({ operationId: "revokeApiKey", responseSchema: apiKeySchema })
  revoke(@Param("id", new ZodValidationPipe(z.uuid())) id: string): Promise<ApiKey> {
    return this.service.revoke(id);
  }
}

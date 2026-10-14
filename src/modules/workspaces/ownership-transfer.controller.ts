import { Body, Controller, HttpCode, Param, Post, Req } from "@nestjs/common";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import type { RbacScopedRequest } from "../../api/guards/rbac.guard.js";
import type { AuditableRequest } from "../../api/interceptors/audit.interceptor.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { assertPathIsTokenWorkspace } from "../../tenancy/assert-matches-tenant.js";
import {
  transferOwnershipParamsSchema,
  transferOwnershipRequestSchema,
  transferOwnershipResponseSchema,
  type TransferOwnershipParams,
  type TransferOwnershipRequest,
  type TransferOwnershipResponse,
} from "./dto/index.js";
import { OwnershipTransferService } from "./ownership-transfer.service.js";
import type { AuditRequestMeta } from "./workspaces.service.js";

// STORY-021 core slice / EC-15 — workspace ownership transfer. Thin on purpose: the permission, the step-up and the
// path-vs-token check are here; every decision (who may act, what state allows it, the pre-flight, the swap) is
// OwnershipTransferService's. `assertPathIsTokenWorkspace` is the strict form: another workspace's id is a 403
// `workspace_mismatch` that confirms nothing about whether that workspace exists.
//
// initiate and cancel carry the permission (owner only; the matrix puts a step-up on it). accept and decline carry NO
// matrix permission beyond `workspace:read` (i.e. membership): what entitles the actor is being the NAMED RECIPIENT of
// the pending transfer, which only the service can know — it answers 403 `forbidden` to everyone else. accept asserts
// its own step-up in the service, after identity.
//
// A separate controller from WorkspacesController so that file's constructor (pinned by its spec) is not widened.
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
export class OwnershipTransferController {
  constructor(private readonly transfers: OwnershipTransferService) {}

  @Post("workspaces/:id/transfer-ownership")
  @HttpCode(200)
  @RequirePermission("workspace:transfer_ownership")
  @Audit({ action: "workspace.ownership_transfer_initiated", resourceType: "workspace", severity: "notice" })
  @ApiContract({
    operationId: "initiateOwnershipTransfer",
    paramsSchema: transferOwnershipParamsSchema,
    requestSchema: transferOwnershipRequestSchema,
    responseSchema: transferOwnershipResponseSchema,
  })
  initiate(
    @Req() req: RbacScopedRequest & AuditableRequest,
    @Param(new ZodValidationPipe(transferOwnershipParamsSchema)) { id }: TransferOwnershipParams,
    @Body(new ZodValidationPipe(transferOwnershipRequestSchema)) body: TransferOwnershipRequest,
  ): Promise<TransferOwnershipResponse> {
    assertPathIsTokenWorkspace(id, req.tenant!.workspaceId);
    return this.transfers.initiate(id, req.tenant!.actorId, body.recipient_id, auditMeta(req));
  }

  @Post("workspaces/:id/transfer-ownership/accept")
  @HttpCode(200)
  @RequirePermission("workspace:read")
  @Audit({ action: "workspace.ownership_transfer_accepted", resourceType: "workspace", severity: "notice" })
  @ApiContract({
    operationId: "acceptOwnershipTransfer",
    paramsSchema: transferOwnershipParamsSchema,
    responseSchema: transferOwnershipResponseSchema,
  })
  accept(
    @Req() req: AuditableRequest,
    @Param(new ZodValidationPipe(transferOwnershipParamsSchema)) { id }: TransferOwnershipParams,
  ): Promise<TransferOwnershipResponse> {
    assertPathIsTokenWorkspace(id, req.tenant!.workspaceId);
    return this.transfers.accept(id, req.tenant!.actorId, req.session?.lastStrongAuthAt ?? null, auditMeta(req));
  }

  @Post("workspaces/:id/transfer-ownership/decline")
  @HttpCode(200)
  @RequirePermission("workspace:read")
  @Audit({ action: "workspace.ownership_transfer_declined", resourceType: "workspace", severity: "notice" })
  @ApiContract({
    operationId: "declineOwnershipTransfer",
    paramsSchema: transferOwnershipParamsSchema,
    responseSchema: transferOwnershipResponseSchema,
  })
  decline(
    @Req() req: AuditableRequest,
    @Param(new ZodValidationPipe(transferOwnershipParamsSchema)) { id }: TransferOwnershipParams,
  ): Promise<TransferOwnershipResponse> {
    assertPathIsTokenWorkspace(id, req.tenant!.workspaceId);
    return this.transfers.decline(id, req.tenant!.actorId, auditMeta(req));
  }

  @Post("workspaces/:id/transfer-ownership/cancel")
  @HttpCode(200)
  @RequirePermission("workspace:transfer_ownership")
  @Audit({ action: "workspace.ownership_transfer_cancelled", resourceType: "workspace", severity: "notice" })
  @ApiContract({
    operationId: "cancelOwnershipTransfer",
    paramsSchema: transferOwnershipParamsSchema,
    responseSchema: transferOwnershipResponseSchema,
  })
  cancel(
    @Req() req: RbacScopedRequest & AuditableRequest,
    @Param(new ZodValidationPipe(transferOwnershipParamsSchema)) { id }: TransferOwnershipParams,
  ): Promise<TransferOwnershipResponse> {
    assertPathIsTokenWorkspace(id, req.tenant!.workspaceId);
    return this.transfers.cancel(id, req.tenant!.actorId, auditMeta(req));
  }
}

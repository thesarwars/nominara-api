import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query, Req } from "@nestjs/common";
import {
  auxAuditListQuerySchema,
  auxAuditSchema,
  auxFindingListQuerySchema,
  auxFindingParamsSchema,
  auxFindingSchema,
  auxPatchSchema,
  triggerAuxAuditPreviewResponseSchema,
  triggerAuxAuditRequestSchema,
  triggerAuxAuditResponseSchema,
  updateAuxFindingRequestSchema,
  type AuxAudit,
  type AuxAuditListQuery,
  type AuxFinding,
  type AuxFindingParams,
  type AuxFindingListQuery,
  type AuxPatch,
  type TriggerAuxAuditPreviewResponse,
  type TriggerAuxAuditRequest,
  type TriggerAuxAuditResponse,
  type UpdateAuxFindingRequest,
} from "../../../contracts/aux/index.js";
import { createTaskFromFindingRequestSchema, taskSchema, type CreateTaskFromFindingRequest, type Task } from "../../../contracts/tasks/index.js";
import type { Page } from "../../api/pagination/page.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { Idempotent } from "../../api/decorators/idempotent.decorator.js";
import { CONFIRMED_CREDITS_HEADER } from "../../lib/credits/confirmed-credits.js";
import type { RbacScopedRequest } from "../../api/guards/rbac.guard.js";
import { RateLimitClass } from "../../api/rate-limit/route-class.js";
import { ProjectParam } from "../../api/decorators/project-param.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ScopedByQuery } from "../../api/decorators/scoped-by-query.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { AuxService } from "./aux.service.js";

// A controller resolves the request, calls one service method, and returns —
// no logic here (coding-standards.md §1). Mounted at the root so the paths are
// the reference's (api-specification.md "AUX").
//
// There is deliberately no route that can set `resolved`: PATCH names it only so
// the refusal is a 422 that says why.
@Controller()
export class AuxController {
  constructor(private readonly service: AuxService) {}

  @Get("aux-audits/:id")
  @RequirePermission("aux:read")
  @ScopedByQuery()
  @ApiContract({ operationId: "getAuxAudit", responseSchema: auxAuditSchema })
  getAudit(@Param("id") id: string): Promise<AuxAudit> {
    return this.service.getAudit(id);
  }

  // Not in the reference: "the latest audit" (`?limit=1`) for the AUX Health page.
  @Get("projects/:id/aux-audits")
  @RequirePermission("aux:read")
  @ProjectParam("id")
  @ApiContract({ operationId: "listProjectAuxAudits", querySchema: auxAuditListQuerySchema, responseSchema: auxAuditSchema, listOf: true })
  listProjectAudits(
    @Param("id") id: string,
    @Query(new ZodValidationPipe(auxAuditListQuerySchema)) query: AuxAuditListQuery,
  ): Promise<Page<AuxAudit>> {
    return this.service.listProjectAudits(id, query);
  }

  // `¢ ✚` in api-specification.md "AUX": priced and idempotent. 202, not 200: the audit is queued and its row exists, but nothing has been read yet.
  // The price is variable (FR-TL-03: first page band flat, then per page), so it is computed in the service from the plan; `@Credits('...')` is the
  // flat-price path and does not fit. Owner decision 39: it charges ONLY with `X-Nominara-Confirmed-Credits` equal to the price recomputed there (the figure
  // `aux-audits/preview` quotes), the same flow as prompt activation. §12's `project_aux_audits` (10/hour per user, 60/hour per workspace, burst 3) applies.
  @Post("projects/:id/aux-audits")
  @HttpCode(202)
  @Idempotent()
  @RateLimitClass("project_aux_audits")
  @RequirePermission("aux:trigger")
  @ProjectParam("id")
  @Audit({ action: "aux_audit.triggered", resourceType: "project" })
  @ApiContract({ operationId: "triggerAuxAudit", requestSchema: triggerAuxAuditRequestSchema, responseSchema: triggerAuxAuditResponseSchema })
  triggerAudit(
    @Req() req: RbacScopedRequest,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(triggerAuxAuditRequestSchema)) body: TriggerAuxAuditRequest,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers(CONFIRMED_CREDITS_HEADER) confirmed?: string | string[],
  ): Promise<TriggerAuxAuditResponse> {
    return this.service.triggerAudit(id, body, { id: req.auth?.sub ?? null, type: "user" }, { idempotencyKey, confirmedCredits: confirmed });
  }

  // Owner decision 39 - the QUOTE half of the priced-action flow. Free, read-only (no reservation, no ledger row, no write, no job), same body as the
  // trigger; `credits` is the figure to echo in `X-Nominara-Confirmed-Credits`. A POST because it carries a body, like `activate/preview`; no
  // `@Idempotent()` for the same reason that route has none (a repeated quote is a repeated read). Audited because the interceptor refuses any mutating
  // method without it, and "what was the operator quoted" is the question a disputed charge asks.
  @Post("projects/:id/aux-audits/preview")
  @HttpCode(200)
  @RequirePermission("aux:trigger")
  @RateLimitClass("reads")
  @ProjectParam("id")
  @Audit({ action: "aux_audit.previewed", resourceType: "project" })
  @ApiContract({ operationId: "previewAuxAudit", requestSchema: triggerAuxAuditRequestSchema, responseSchema: triggerAuxAuditPreviewResponseSchema })
  previewAudit(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(triggerAuxAuditRequestSchema)) body: TriggerAuxAuditRequest,
  ): Promise<TriggerAuxAuditPreviewResponse> {
    return this.service.previewAudit(id, body);
  }

  @Get("projects/:id/aux-findings")
  @RequirePermission("aux:read")
  @ProjectParam("id")
  @ApiContract({ operationId: "listProjectAuxFindings", querySchema: auxFindingListQuerySchema, responseSchema: auxFindingSchema, listOf: true })
  listProjectFindings(
    @Param("id") id: string,
    @Query(new ZodValidationPipe(auxFindingListQuerySchema)) query: AuxFindingListQuery,
  ): Promise<Page<AuxFinding>> {
    return this.service.listProjectFindings(id, query);
  }

  // STORY-053: a patch is made by the audit and read here; there is no route that creates, regenerates or edits one. The URL names a
  // patch, not a project: scope is enforced by the service against the patch's project (403 out-of-scope).
  @Get("patches/:id")
  @RequirePermission("aux:read")
  @ScopedByQuery()
  @ApiContract({ operationId: "getAuxPatch", responseSchema: auxPatchSchema })
  getPatch(@Param("id") id: string): Promise<AuxPatch> {
    return this.service.getPatch(id);
  }

  // `POST /aux-findings/{id}/create-task`, `task:create` (STORY-194 AC5). Idempotent: a replayed key returns the first response, and
  // the service never makes a second open task for one finding. The URL names a finding: scope is enforced by the service.
  @Post("aux-findings/:id/create-task")
  @HttpCode(201)
  @Idempotent()
  @RequirePermission("task:create")
  @ScopedByQuery()
  @Audit({ action: "task.created", resourceType: "task", resourceIdFrom: "response" })
  @ApiContract({ operationId: "createTaskFromAuxFinding", paramsSchema: auxFindingParamsSchema, requestSchema: createTaskFromFindingRequestSchema, responseSchema: taskSchema })
  createTaskFromFinding(
    @Param(new ZodValidationPipe(auxFindingParamsSchema)) { id }: AuxFindingParams,
    @Body(new ZodValidationPipe(createTaskFromFindingRequestSchema.default({}))) _body: CreateTaskFromFindingRequest,
  ): Promise<Task> {
    return this.service.createTaskFromFinding(id);
  }

  // The URL names a finding, not a project: scope is enforced by the service
  // against the finding's project (403 out-of-scope), as PATCH /tasks/{id} does.
  @Patch("aux-findings/:id")
  @RequirePermission("task:create")
  @ScopedByQuery()
  @Audit({ action: "aux_finding.updated", resourceType: "aux_finding" })
  @ApiContract({ operationId: "updateAuxFinding", paramsSchema: auxFindingParamsSchema, requestSchema: updateAuxFindingRequestSchema, responseSchema: auxFindingSchema })
  updateFinding(
    @Param(new ZodValidationPipe(auxFindingParamsSchema)) { id }: AuxFindingParams,
    @Body(new ZodValidationPipe(updateAuxFindingRequestSchema)) body: UpdateAuxFindingRequest,
  ): Promise<AuxFinding> {
    return this.service.updateFinding(id, body);
  }
}

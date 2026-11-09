import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req } from "@nestjs/common";
import {
  alignmentIdParamSchema,
  alignmentSessionPayloadSchema,
  createAlignmentPatchRequestSchema,
  createAlignmentPatchResponseSchema,
  openAlignmentRequestSchema,
  openAlignmentResponseSchema,
  updateAlignmentDraftRequestSchema,
  type AlignmentSessionPayload,
  type CreateAlignmentPatchRequest,
  type CreateAlignmentPatchResponse,
  type OpenAlignmentRequest,
  type OpenAlignmentResponse,
  type UpdateAlignmentDraftRequest,
} from "../../../contracts/analytics/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { Idempotent } from "../../api/decorators/idempotent.decorator.js";
import { RequireFeature } from "../../api/decorators/require-entitlement.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ScopedByQuery } from "../../api/decorators/scoped-by-query.decorator.js";
import type { RbacScopedRequest } from "../../api/guards/rbac.guard.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { RateLimitClass } from "../../api/rate-limit/route-class.js";
import { AlignmentService } from "./alignment.service.js";

// STORY-192 - `/geo/alignment` (api-specification.md "GEO"). Every route is `optimizer:use` (manager scoped, analyst and viewer denied: a
// permission denial is `403` naming the permission, never `404`) and behind the `optimizer.enabled` feature flag (Free is `403 feature_not_in_plan`).
// All four are 0 credits and unlimited. Mounted at the root of the geo module so the paths are the reference's.
//
// The URL of three of the four names a SESSION, not a project, and the open route names the project in its body: scope is enforced by the service
// against the session's (or the body's) project (`403 project_out_of_scope`), as PATCH /aux-findings/{id} does.
//
// There is deliberately NO route that generates, rewrites or completes text (aux-and-geo-analysis.md section 9): the draft is the customer's own,
// sent to be measured, and the patch is that draft with its precondition hash.
@Controller("geo/alignment")
export class AlignmentController {
  constructor(private readonly service: AlignmentService) {}

  // `✚`: an `Idempotency-Key` is required. 202: the session exists and is `pending`; `poll_url` is where it will say `ready`. §12's `geo_alignment`
  // rate class (30/hour per user, 120/hour per workspace, burst 5) applies.
  @Post()
  @HttpCode(202)
  @Idempotent()
  @RateLimitClass("geo_alignment")
  @RequirePermission("optimizer:use")
  @RequireFeature("optimizer.enabled")
  @ScopedByQuery()
  @Audit({ action: "geo_alignment.opened", resourceType: "geo_alignment", resourceIdFrom: "response", responseIdPath: "session_id" })
  @ApiContract({ operationId: "openGeoAlignment", requestSchema: openAlignmentRequestSchema, responseSchema: openAlignmentResponseSchema })
  open(
    @Req() req: RbacScopedRequest,
    @Body(new ZodValidationPipe(openAlignmentRequestSchema)) body: OpenAlignmentRequest,
  ): Promise<OpenAlignmentResponse> {
    return this.service.open(body, { id: req.auth?.sub ?? null });
  }

  @Get(":id")
  @RequirePermission("optimizer:use")
  @RequireFeature("optimizer.enabled")
  @ScopedByQuery()
  @ApiContract({ operationId: "getGeoAlignment", responseSchema: alignmentSessionPayloadSchema })
  get(@Param("id", new ZodValidationPipe(alignmentIdParamSchema)) id: string): Promise<AlignmentSessionPayload> {
    return this.service.get(id);
  }

  // The body is the customer's draft: it is NEVER recorded in the audit row (the closed `afterState` names outcome fields only).
  @Patch(":id")
  @RequirePermission("optimizer:use")
  @RequireFeature("optimizer.enabled")
  @ScopedByQuery()
  @Audit({
    action: "geo_alignment.draft_updated",
    resourceType: "geo_alignment",
    afterState: (body) => {
      const payload = body as { status?: unknown; draft_status?: unknown } | null;
      return { status: payload?.status ?? null, draft_status: payload?.draft_status ?? null };
    },
  })
  @ApiContract({ operationId: "updateGeoAlignmentDraft", requestSchema: updateAlignmentDraftRequestSchema, responseSchema: alignmentSessionPayloadSchema })
  updateDraft(
    @Param("id", new ZodValidationPipe(alignmentIdParamSchema)) id: string,
    @Body(new ZodValidationPipe(updateAlignmentDraftRequestSchema)) body: UpdateAlignmentDraftRequest,
  ): Promise<AlignmentSessionPayload> {
    return this.service.updateDraft(id, body);
  }

  // `✚`. 201: a new immutable row every time; the response is the same wire shape as `GET /patches/{id}`. The patch text is the customer's own draft,
  // so the audit row records the outcome (the patch id and whether review is required), never the text.
  @Post(":id/patch")
  @HttpCode(201)
  @Idempotent()
  @RequirePermission("optimizer:use")
  @RequireFeature("optimizer.enabled")
  @ScopedByQuery()
  @Audit({
    action: "geo_alignment.patched",
    resourceType: "geo_alignment",
    afterState: (body) => {
      const patch = body as { patch_id?: unknown; kind?: unknown; requires_human_review?: unknown } | null;
      return { patch_id: patch?.patch_id ?? null, kind: patch?.kind ?? null, requires_human_review: patch?.requires_human_review ?? null };
    },
  })
  @ApiContract({ operationId: "createGeoAlignmentPatch", requestSchema: createAlignmentPatchRequestSchema, responseSchema: createAlignmentPatchResponseSchema })
  createPatch(
    @Req() req: RbacScopedRequest,
    @Param("id", new ZodValidationPipe(alignmentIdParamSchema)) id: string,
    @Body(new ZodValidationPipe(createAlignmentPatchRequestSchema)) _body: CreateAlignmentPatchRequest,
  ): Promise<CreateAlignmentPatchResponse> {
    return this.service.createPatch(id, { id: req.auth?.sub ?? null });
  }
}

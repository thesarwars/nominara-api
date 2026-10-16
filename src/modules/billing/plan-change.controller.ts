import { Body, Controller, Delete, HttpCode, Post } from "@nestjs/common";
import {
  planChangeCancelResponseSchema,
  planChangePreviewRequestSchema,
  planChangePreviewResponseSchema,
  planChangeRequestSchema,
  planChangeResponseSchema,
  type PlanChangeCancelResponse,
  type PlanChangePreviewRequest,
  type PlanChangePreviewResponse,
  type PlanChangeRequest,
  type PlanChangeResponse,
} from "../../../contracts/billing/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { Idempotent } from "../../api/decorators/idempotent.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { RateLimitClass } from "../../api/rate-limit/route-class.js";
import { PlanChangeService } from "./plan-change.service.js";

// STORY-184 — api-specification.md §3's in-app plan change. All three routes are billing:write (owner and admin) and
// need no step-up (owner decision 2026-10-16). The change and its cancel share the `plan_change` rate class (§12); the
// preview charges nothing and is an ordinary write. The change answers 202 `pending`: the plan changes only when the
// signature-verified webhook reconciles the subscription.
@Controller("billing/subscription/change")
export class PlanChangeController {
  constructor(private readonly service: PlanChangeService) {}

  // Audited because every mutating verb must be (AuditInterceptor refuses an unaudited POST); the preview itself writes
  // and charges nothing, and its row is named `previewed`, never `requested`.
  @Post("preview")
  @HttpCode(200)
  @RateLimitClass("plan_change_preview")
  @RequirePermission("billing:write")
  @Audit({ action: "billing.plan_change.previewed", resourceType: "workspace", resourceIdFrom: "workspace" })
  @ApiContract({ operationId: "previewPlanChange", requestSchema: planChangePreviewRequestSchema, responseSchema: planChangePreviewResponseSchema })
  preview(@Body(new ZodValidationPipe(planChangePreviewRequestSchema)) body: PlanChangePreviewRequest): Promise<PlanChangePreviewResponse> {
    return this.service.preview(body);
  }

  @Post()
  @HttpCode(202)
  @Idempotent()
  @RateLimitClass("plan_change")
  @RequirePermission("billing:write")
  @Audit({ action: "billing.plan_change.requested", resourceType: "workspace", resourceIdFrom: "workspace" })
  @ApiContract({ operationId: "changePlan", requestSchema: planChangeRequestSchema, responseSchema: planChangeResponseSchema })
  change(@Body(new ZodValidationPipe(planChangeRequestSchema)) body: PlanChangeRequest): Promise<PlanChangeResponse> {
    return this.service.change(body);
  }

  @Delete()
  @HttpCode(200)
  @RateLimitClass("plan_change")
  @RequirePermission("billing:write")
  @Audit({ action: "billing.plan_change.cancelled", resourceType: "workspace", resourceIdFrom: "workspace" })
  @ApiContract({ operationId: "cancelPlanChange", responseSchema: planChangeCancelResponseSchema })
  cancel(): Promise<PlanChangeCancelResponse> {
    return this.service.cancel();
  }
}

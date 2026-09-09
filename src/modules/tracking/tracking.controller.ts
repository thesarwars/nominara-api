import { Body, Controller, HttpCode, Param, Post, Req } from "@nestjs/common";
import {
  runEstimateResponseSchema,
  runProgressResponseSchema,
  triggerRunRequestSchema,
  type RunEstimateResponse,
  type RunProgressResponse,
  type TriggerRunRequest,
} from "../../../contracts/tracking/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { Credits } from "../../api/decorators/credits.decorator.js";
import { Idempotent } from "../../api/decorators/idempotent.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import type { RbacScopedRequest } from "../../api/guards/rbac.guard.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { RunEstimateService } from "./run-estimate.service.js";
import { RunLifecycleService } from "./run-lifecycle.service.js";

// STORY-034 — api-specification.md §3's Tracking table, the project-scoped
// half. A controller resolves the request, calls one service method, and
// returns (coding-standards.md §1).
//
// The parameter is `:id`, following §3's spelling and every other nested
// route in the generated document — `/projects/{id}/prompts`,
// `/projects/{id}/discovery`.
@Controller("projects/:id/runs")
export class TrackingController {
  constructor(
    private readonly estimates: RunEstimateService,
    private readonly lifecycle: RunLifecycleService,
  ) {}

  // 200, not 202 or 201: nothing is created. §3 marks this route neither `✚`
  // nor `¢` — free, no idempotency key, nothing to replay, because a repeated
  // estimate is a repeated read.
  //
  // `tracking:trigger` rather than `tracking:read`, from §3's own permission
  // column. Knowing what a scan would cost is part of deciding to run one,
  // and a viewer who cannot trigger has no decision to make.
  @Post("estimate")
  @HttpCode(200)
  @RequirePermission("tracking:trigger")
  @ApiContract({
    operationId: "estimateRun",
    requestSchema: triggerRunRequestSchema,
    responseSchema: runEstimateResponseSchema,
  })
  estimate(
    @Param("id") projectId: string,
    @Body(new ZodValidationPipe(triggerRunRequestSchema)) _body: TriggerRunRequest,
  ): Promise<RunEstimateResponse> {
    return this.estimates.estimate(projectId);
  }

  // §3 marks this route `✚ ¢` — an idempotency key AND a confirmed price.
  //
  // 202, not 200: the run is planned and its row exists, but every live cell
  // is a queued job. Returning 200 would claim results are readable, and the
  // progress projection this returns says plainly that they are not yet.
  //
  // `@Credits('deep_scan')` is what makes `X-Nominara-Confirmed-Credits`
  // mandatory here — §1's header table: "Echoes the exact figure shown to
  // the operator. A mismatch is `409 price_changed`."
  @Post()
  @HttpCode(202)
  @Idempotent()
  @Credits("deep_scan")
  @RequirePermission("tracking:trigger")
  // Audited because it is a priced action against a plan's allowance, and
  // because which prompts were asked on which day IS the measurement — a
  // manual scan changes the series every later number is read against.
  @Audit({ action: "run.triggered", resourceType: "project" })
  @ApiContract({
    operationId: "triggerRun",
    requestSchema: triggerRunRequestSchema,
    responseSchema: runProgressResponseSchema,
  })
  trigger(
    @Req() req: RbacScopedRequest,
    @Param("id") projectId: string,
    @Body(new ZodValidationPipe(triggerRunRequestSchema)) _body: TriggerRunRequest,
  ): Promise<RunProgressResponse> {
    return this.lifecycle.trigger(projectId, req.auth?.sub ?? null);
  }
}

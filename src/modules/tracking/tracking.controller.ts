import { Body, Controller, HttpCode, Param, Post } from "@nestjs/common";
import {
  runEstimateResponseSchema,
  triggerRunRequestSchema,
  type RunEstimateResponse,
  type TriggerRunRequest,
} from "../../../contracts/tracking/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { RunEstimateService } from "./run-estimate.service.js";

// STORY-034 — api-specification.md §3's Tracking table, the project-scoped
// half. A controller resolves the request, calls one service method, and
// returns (coding-standards.md §1).
//
// The parameter is `:id`, following §3's spelling and every other nested
// route in the generated document — `/projects/{id}/prompts`,
// `/projects/{id}/discovery`.
@Controller("projects/:id/runs")
export class TrackingController {
  constructor(private readonly estimates: RunEstimateService) {}

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
}

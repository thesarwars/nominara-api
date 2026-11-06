import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query, Req, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import {
  convertToolRunRequestSchema,
  discoverPromptsRequestSchema,
  discoverPromptsResponseSchema,
  keepPromptsRequestSchema,
  keepPromptsResponseSchema,
  promptResearchEstimateQuerySchema,
  promptResearchEstimateResponseSchema,
  promptResearchRunAcceptedSchema,
  promptResearchRunRequestSchema,
  convertToolRunResponseSchema,
  scanStreamCompletedSchema,
  toolRunConversionPreviewSchema,
  toolRunDetailSchema,
  toolRunIdSchema,
  toolRunListQuerySchema,
  toolRunListResponseSchema,
  toolRunSchema,
  updateToolRunRequestSchema,
  visibilityScanEstimateResponseSchema,
  visibilityScanRequestSchema,
  type ConvertToolRunRequest,
  type ConvertToolRunResponse,
  type DiscoverPromptsRequest,
  type DiscoverPromptsResponse,
  type KeepPromptsRequest,
  type KeepPromptsResponse,
  type PromptResearchEstimateQuery,
  type PromptResearchEstimateResponse,
  type PromptResearchRunAccepted,
  type PromptResearchRunRequest,
  type ToolRun,
  type ToolRunConversionPreview,
  type ToolRunDetail,
  type ToolRunListQuery,
  type UpdateToolRunRequest,
  type VisibilityScanEstimateResponse,
  type VisibilityScanRequest,
} from "../../../contracts/tools/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { RateLimitClass } from "../../api/rate-limit/route-class.js";
import { DailyCap } from "../../api/decorators/daily-cap.decorator.js";
import { Streaming } from "../../api/decorators/streaming.decorator.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { Idempotent } from "../../api/decorators/idempotent.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ScopedByQuery } from "../../api/decorators/scoped-by-query.decorator.js";
import { entityTagFor, formatEntityTag } from "../../api/etag/entity-tag.js";
import { ifNoneMatchMatches } from "../../api/etag/if-none-match.js";
import type { Page } from "../../api/pagination/page.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import type { AuditableRequest } from "../../api/interceptors/audit.interceptor.js";
import { openSseReply } from "../../api/streaming/sse-reply.js";
import { ToolsService } from "./tools.service.js";
import { PromptResearchService } from "./prompt-research.service.js";
import { VisibilityScanService } from "./visibility-scan.service.js";

// A controller resolves the request, calls one service method, and returns - no logic here (coding-standards.md section 1).
// api-specification.md section 3 "Tools". Tool runs belong to the WORKSPACE, not to a project, so these routes name no project and
// declare `@ScopedByQuery()`: a project-scoped member is not refused outright for a route that has no project to check.
//
// Reading is 0 credits, always (FR-TL-06): none of the GET routes is `@Credits`-guarded, and the service reads `result_json` only.
const idPipe = new ZodValidationPipe(toolRunIdSchema);

@Controller("tools")
export class ToolsController {
  constructor(
    private readonly service: ToolsService,
    private readonly scans: VisibilityScanService,
    private readonly research: PromptResearchService,
  ) {}

  // STORY-079 / NFR-API-11 - the free paired estimate: the flat price, the engines named before the run, and nothing selectable.
  @Get("visibility-scan/estimate")
  @RequirePermission("lookup:execute")
  @ScopedByQuery()
  @ApiContract({ operationId: "estimateVisibilityScan", responseSchema: visibilityScanEstimateResponseSchema })
  estimateScan(): Promise<VisibilityScanEstimateResponse> {
    return this.scans.estimate();
  }

  // STORY-079 - api-specification.md section 9. Refusals (400 / 402 / 409 / 429) are ordinary problem responses BEFORE the stream opens; once it has
  // opened, every outcome - including all engines failing - ends with `scan.completed`. @Streaming(): the request holds no transaction across the stream.
  @Post("visibility-scan")
  @Streaming()
  @RequirePermission("lookup:execute")
  @ScopedByQuery()
  @DailyCap("lookup")
  @RateLimitClass("capture_backed_tools")
  @ApiContract({ operationId: "startVisibilityScan", requestSchema: visibilityScanRequestSchema, responseSchema: scanStreamCompletedSchema, requiresIdempotencyKey: true })
  async scan(
    @Body(new ZodValidationPipe(visibilityScanRequestSchema)) body: VisibilityScanRequest,
    @Headers("x-nominara-confirmed-credits") confirmedCredits: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Headers("user-agent") userAgent: string | undefined,
    @Req() request: AuditableRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const tenant = request.tenant;
    if (tenant === undefined) throw new Error("the scan route has no tenant context: WorkspaceGuard did not run");
    const accepted = await this.scans.accept(
      tenant,
      body,
      { confirmedCredits, idempotencyKey },
      { actorType: request.authMethod === "apiKey" ? "api_key" : "user", ip: request.ip ?? null, userAgent: userAgent ?? null, requestId: String(request.id ?? "") },
    );
    await this.scans.stream(tenant, accepted, openSseReply(reply));
  }

  // STORY-080 / FR-TL-01 - Prompt Research. Discover is free and writes nothing; Keep charges per prompt kept; Run charges per answer and is answered by the worker.
  // Neither mode touches a project: the routes are workspace-scoped like every tool (`@ScopedByQuery()`).
  @Get("prompt-research/estimate")
  @RequirePermission("lookup:execute")
  @ScopedByQuery()
  @ApiContract({ operationId: "estimatePromptResearch", querySchema: promptResearchEstimateQuerySchema, responseSchema: promptResearchEstimateResponseSchema })
  estimateResearch(@Query(new ZodValidationPipe(promptResearchEstimateQuerySchema)) query: PromptResearchEstimateQuery): Promise<PromptResearchEstimateResponse> {
    return this.research.estimate(query);
  }

  @Post("prompt-research/discover")
  @HttpCode(200)
  @Idempotent()
  @RequirePermission("prompt:write")
  @ScopedByQuery()
  // Free and stateless, but still a POST that runs the generator: audited like every mutating route (the row records that it ran, never a debit).
  @Audit({ action: "tool_run.prompts_discovered", resourceType: "workspace", resourceIdFrom: "workspace", afterState: (body) => ({ generated: (body as DiscoverPromptsResponse).generated }) })
  @ApiContract({ operationId: "discoverResearchPrompts", requestSchema: discoverPromptsRequestSchema, responseSchema: discoverPromptsResponseSchema, requiresIdempotencyKey: true })
  discoverPrompts(@Body(new ZodValidationPipe(discoverPromptsRequestSchema)) body: DiscoverPromptsRequest): Promise<DiscoverPromptsResponse> {
    return this.research.discover(body);
  }

  @Post("prompt-research/keep")
  @HttpCode(200)
  @Idempotent()
  @RequirePermission("prompt:write")
  @ScopedByQuery()
  @Audit({ action: "tool_run.prompts_kept", resourceType: "tool_run", resourceIdFrom: "response", afterState: (body) => ({ kept_count: (body as KeepPromptsResponse).kept_count, credits_charged: (body as KeepPromptsResponse).credits_charged }) })
  @ApiContract({ operationId: "keepResearchPrompts", requestSchema: keepPromptsRequestSchema, responseSchema: keepPromptsResponseSchema, requiresIdempotencyKey: true })
  keepPrompts(
    @Body(new ZodValidationPipe(keepPromptsRequestSchema)) body: KeepPromptsRequest,
    @Headers("x-nominara-confirmed-credits") confirmedCredits: string | undefined,
  ): Promise<KeepPromptsResponse> {
    return this.research.keep(body, confirmedCredits);
  }

  @Post("prompt-research/run")
  @HttpCode(202)
  @Idempotent()
  @RequirePermission("lookup:execute")
  @ScopedByQuery()
  @DailyCap("lookup")
  @RateLimitClass("capture_backed_tools")
  @Audit({ action: "tool_run.research_started", resourceType: "tool_run", resourceIdFrom: "response", afterState: (body) => ({ prompts: (body as PromptResearchRunAccepted).prompts, answers: (body as PromptResearchRunAccepted).answers, credits: (body as PromptResearchRunAccepted).credits.charged }) })
  @ApiContract({ operationId: "startPromptResearch", requestSchema: promptResearchRunRequestSchema, responseSchema: promptResearchRunAcceptedSchema, requiresIdempotencyKey: true })
  runResearch(
    @Body(new ZodValidationPipe(promptResearchRunRequestSchema)) body: PromptResearchRunRequest,
    @Headers("x-nominara-confirmed-credits") confirmedCredits: string | undefined,
    @Req() request: AuditableRequest,
  ): Promise<PromptResearchRunAccepted> {
    return this.research.run(body, confirmedCredits, { requestId: String(request.id ?? "") });
  }

  @Get("runs")
  @RequirePermission("lookup:read_history")
  @ScopedByQuery()
  @ApiContract({ operationId: "listToolRuns", querySchema: toolRunListQuerySchema, responseSchema: toolRunListResponseSchema, listOf: true })
  list(@Query(new ZodValidationPipe(toolRunListQuerySchema)) query: ToolRunListQuery): Promise<Page<ToolRun>> {
    return this.service.list(query);
  }

  // AC12 - the entity tag lets an unchanged run revalidate (304, no body) instead of re-transferring.
  @Get("runs/:id")
  @RequirePermission("lookup:read_history")
  @ScopedByQuery()
  @ApiContract({ operationId: "getToolRun", responseSchema: toolRunDetailSchema, emitsEntityTag: true })
  async getOne(
    @Param("id", idPipe) id: string,
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ToolRunDetail | undefined> {
    const run = await this.service.get(id);
    const tag = entityTagFor(run);
    reply.header("ETag", formatEntityTag(tag));
    if (ifNoneMatchMatches(ifNoneMatch, tag)) {
      reply.status(304);
      return undefined;
    }
    return run;
  }

  // api-specification section 3 gives PATCH /tools/runs/{id} the permission `lookup:read_history` - pinning is a per-run flag on a row the
  // caller can already read, with no credit or retention effect - so that is deliberately NOT a write permission.
  @Patch("runs/:id")
  @RequirePermission("lookup:read_history")
  @ScopedByQuery()
  @Audit({ action: "tool_run.pinned", resourceType: "tool_run", afterState: (body) => ({ pinned: (body as ToolRun).pinned }) })
  @ApiContract({ operationId: "updateToolRun", requestSchema: updateToolRunRequestSchema, responseSchema: toolRunSchema })
  update(
    @Param("id", idPipe) id: string,
    @Body(new ZodValidationPipe(updateToolRunRequestSchema)) body: UpdateToolRunRequest,
  ): Promise<ToolRun> {
    return this.service.setPinned(id, body.pinned);
  }

  // AC17 - the slot cost, before the click.
  @Get("runs/:id/convert")
  @RequirePermission("lookup:read_history")
  @ScopedByQuery()
  @ApiContract({ operationId: "getToolRunConversion", responseSchema: toolRunConversionPreviewSchema })
  preview(@Param("id", idPipe) id: string): Promise<ToolRunConversionPreview> {
    return this.service.conversionPreview(id);
  }

  // AC16, AC20 - 200 either way: the first call creates the project, a repeat returns it (`already_converted`). The body names no
  // project, so there is nothing for the project-scope check to bind to; the new project is created by this caller's `project:create`.
  @Post("runs/:id/convert")
  @HttpCode(200)
  @Idempotent()
  @RequirePermission("project:create")
  @ScopedByQuery()
  @Audit({
    action: "tool_run.converted",
    resourceType: "tool_run",
    afterState: (body) => ({ project_id: (body as ConvertToolRunResponse).project_id, already_converted: (body as ConvertToolRunResponse).already_converted }),
  })
  @ApiContract({ operationId: "convertToolRun", requestSchema: convertToolRunRequestSchema, responseSchema: convertToolRunResponseSchema })
  convert(
    @Param("id", idPipe) id: string,
    @Body(new ZodValidationPipe(convertToolRunRequestSchema)) body: ConvertToolRunRequest,
  ): Promise<ConvertToolRunResponse> {
    return this.service.convert(id, body);
  }
}

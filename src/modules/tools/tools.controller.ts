import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import {
  convertToolRunRequestSchema,
  convertToolRunResponseSchema,
  toolRunConversionPreviewSchema,
  toolRunDetailSchema,
  toolRunIdSchema,
  toolRunListQuerySchema,
  toolRunSchema,
  updateToolRunRequestSchema,
  type ConvertToolRunRequest,
  type ConvertToolRunResponse,
  type ToolRun,
  type ToolRunConversionPreview,
  type ToolRunDetail,
  type ToolRunListQuery,
  type UpdateToolRunRequest,
} from "../../../contracts/tools/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ScopedByQuery } from "../../api/decorators/scoped-by-query.decorator.js";
import { entityTagFor, formatEntityTag } from "../../api/etag/entity-tag.js";
import { ifNoneMatchMatches } from "../../api/etag/if-none-match.js";
import type { Page } from "../../api/pagination/page.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { ToolsService } from "./tools.service.js";

// A controller resolves the request, calls one service method, and returns - no logic here (coding-standards.md section 1).
// api-specification.md section 3 "Tools". Tool runs belong to the WORKSPACE, not to a project, so these routes name no project and
// declare `@ScopedByQuery()`: a project-scoped member is not refused outright for a route that has no project to check.
//
// Reading is 0 credits, always (FR-TL-06): none of the GET routes is `@Credits`-guarded, and the service reads `result_json` only.
const idPipe = new ZodValidationPipe(toolRunIdSchema);

@Controller("tools")
export class ToolsController {
  constructor(private readonly service: ToolsService) {}

  @Get("runs")
  @RequirePermission("lookup:read_history")
  @ScopedByQuery()
  @ApiContract({ operationId: "listToolRuns", querySchema: toolRunListQuerySchema, responseSchema: toolRunSchema, listOf: true })
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

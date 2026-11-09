import { Controller, Get, Param } from "@nestjs/common";
import {
  projectBenchmarkParamsSchema,
  projectBenchmarkResponseSchema,
  type ProjectBenchmarkParams,
  type ProjectBenchmarkResponse,
} from "../../../contracts/projects/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { ProjectParam } from "../../api/decorators/project-param.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { ProjectBenchmarkService } from "./project-benchmark.service.js";

// `GET /projects/{id}/benchmark` — project:read, like the other reads of a project. A plain read: nothing is created or audited.
@Controller("projects/:id/benchmark")
export class ProjectBenchmarkController {
  constructor(private readonly benchmark: ProjectBenchmarkService) {}

  @Get()
  @RequirePermission("project:read")
  @ProjectParam("id")
  @ApiContract({ operationId: "getProjectBenchmark", paramsSchema: projectBenchmarkParamsSchema, responseSchema: projectBenchmarkResponseSchema })
  read(@Param(new ZodValidationPipe(projectBenchmarkParamsSchema)) { id }: ProjectBenchmarkParams): Promise<ProjectBenchmarkResponse> {
    return this.benchmark.read(id);
  }
}

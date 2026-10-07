import { Controller, Get, Param, Query } from "@nestjs/common";
import {
  taskListQuerySchema,
  taskListResponseSchema,
  type Task,
  type TaskListQuery,
} from "../../../contracts/tasks/index.js";
import type { Page } from "../../api/pagination/page.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { ProjectParam } from "../../api/decorators/project-param.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { TasksService } from "./tasks.service.js";

// A controller resolves the request, calls one service method, and returns
// — no logic here (coding-standards.md §1).
//
// STORY-064 (step A) — api-specification.md §3: `GET /projects/{id}/tasks`,
// `task:read`. Mounted at the root so the path is `/projects/:id/tasks`
// (the `workspaces/:id/*` routes use the same flattening). `@ProjectParam`
// makes RbacGuard refuse a scoped caller's out-of-scope project with the 403
// that names `task:read`; an out-of-TENANT id is a 404 from the service.
@Controller()
export class TasksController {
  constructor(private readonly service: TasksService) {}

  @Get("projects/:id/tasks")
  @RequirePermission("task:read")
  @ProjectParam("id")
  @ApiContract({
    operationId: "listProjectTasks",
    querySchema: taskListQuerySchema,
    responseSchema: taskListResponseSchema,
    listOf: true,
  })
  list(
    @Param("id") id: string,
    @Query(new ZodValidationPipe(taskListQuerySchema)) query: TaskListQuery,
  ): Promise<Page<Task>> {
    return this.service.listProjectTasks(id, query);
  }
}

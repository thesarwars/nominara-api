import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import {
  completeTaskResponseSchema,
  createCommentRequestSchema,
  createTaskRequestSchema,
  taskEventListQuerySchema,
  taskEventListResponseSchema,
  taskEventSchema,
  taskListQuerySchema,
  taskListResponseSchema,
  taskSchema,
  updateTaskRequestSchema,
  type CompleteTaskResponse,
  type CreateCommentRequest,
  type CreateTaskRequest,
  type Task,
  type TaskEvent,
  type TaskEventListQuery,
  type TaskListQuery,
  type UpdateTaskRequest,
} from "../../../contracts/tasks/index.js";
import type { Page } from "../../api/pagination/page.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { ProjectParam } from "../../api/decorators/project-param.decorator.js";
import { Idempotent } from "../../api/decorators/idempotent.decorator.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { ScopedByQuery } from "../../api/decorators/scoped-by-query.decorator.js";
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

  // STORY-064 (step B) — api-specification.md §3: `PATCH /tasks/{id}`,
  // `task:move` (manager scoped). The URL names a TASK, not a project, so
  // `@ProjectParam` has nothing to bind; `@ScopedByQuery` lets a non-empty
  // scope through and the service enforces it against the task's project
  // (403 out-of-scope), still refusing an empty scope in the guard.
  @Patch("tasks/:id")
  @RequirePermission("task:move")
  @ScopedByQuery()
  @Audit({ action: "task.updated", resourceType: "task" })
  @ApiContract({ operationId: "updateTask", requestSchema: updateTaskRequestSchema, responseSchema: taskSchema })
  update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateTaskRequestSchema)) body: UpdateTaskRequest,
  ): Promise<Task> {
    return this.service.updateTask(id, body);
  }

  // STORY-064 (step C) — `POST /projects/{id}/tasks`, `task:create` (manager
  // scoped). Idempotent: a replayed `Idempotency-Key` returns the same task
  // rather than a second one with the next reference.
  @Post("projects/:id/tasks")
  @HttpCode(201)
  @Idempotent()
  @RequirePermission("task:create")
  @ProjectParam("id")
  @Audit({ action: "task.created", resourceType: "task", resourceIdFrom: "response" })
  @ApiContract({ operationId: "createProjectTask", requestSchema: createTaskRequestSchema, responseSchema: taskSchema })
  create(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(createTaskRequestSchema)) body: CreateTaskRequest,
  ): Promise<Task> {
    return this.service.createTask(id, body);
  }

  // `POST /tasks/{id}/comments`, `task:comment`. Like PATCH, the URL names a
  // task: scope is enforced by the service against the task's project.
  @Post("tasks/:id/comments")
  @HttpCode(201)
  @Idempotent()
  @RequirePermission("task:comment")
  @ScopedByQuery()
  @Audit({ action: "task.commented", resourceType: "task" })
  @ApiContract({ operationId: "createTaskComment", requestSchema: createCommentRequestSchema, responseSchema: taskEventSchema })
  comment(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(createCommentRequestSchema)) body: CreateCommentRequest,
  ): Promise<TaskEvent> {
    return this.service.createComment(id, body);
  }

  // STORY-064 (step D) — `POST /tasks/{id}/complete`, `task:move`. No body.
  // Idempotent: a replayed key returns the first response, not a second 409.
  @Post("tasks/:id/complete")
  @HttpCode(200)
  @Idempotent()
  @RequirePermission("task:move")
  @ScopedByQuery()
  @Audit({ action: "task.completed", resourceType: "task" })
  @ApiContract({ operationId: "completeTask", responseSchema: completeTaskResponseSchema })
  complete(@Param("id") id: string): Promise<CompleteTaskResponse> {
    return this.service.completeTask(id);
  }

  // `GET /tasks/{id}/events`, `task:read` — the timeline, newest first.
  @Get("tasks/:id/events")
  @RequirePermission("task:read")
  @ScopedByQuery()
  @ApiContract({
    operationId: "listTaskEvents",
    querySchema: taskEventListQuerySchema,
    responseSchema: taskEventListResponseSchema,
    listOf: true,
  })
  events(
    @Param("id") id: string,
    @Query(new ZodValidationPipe(taskEventListQuerySchema)) query: TaskEventListQuery,
  ): Promise<Page<TaskEvent>> {
    return this.service.listTaskEvents(id, query);
  }
}

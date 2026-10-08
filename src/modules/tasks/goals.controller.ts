import { Body, Controller, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
import {
  createGoalRequestSchema,
  goalListResponseSchema,
  goalSchema,
  updateGoalRequestSchema,
  type CreateGoalRequest,
  type Goal,
  type UpdateGoalRequest,
} from "../../../contracts/tasks/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { Idempotent } from "../../api/decorators/idempotent.decorator.js";
import { ProjectParam } from "../../api/decorators/project-param.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { GoalsService } from "./goals.service.js";

// STORY-065 (step A) — api-specification.md §3: `GET`/`POST`/`PATCH`
// `/projects/{id}/goals`, all `task:create`. No logic here.
@Controller()
export class GoalsController {
  constructor(private readonly service: GoalsService) {}

  @Get("projects/:id/goals")
  @RequirePermission("task:create")
  @ProjectParam("id")
  @ApiContract({ operationId: "listProjectGoals", responseSchema: goalListResponseSchema })
  list(@Param("id") id: string): Promise<Goal[]> {
    return this.service.listGoals(id);
  }

  @Post("projects/:id/goals")
  @HttpCode(201)
  @Idempotent()
  @RequirePermission("task:create")
  @ProjectParam("id")
  @Audit({ action: "goal.created", resourceType: "goal", resourceIdFrom: "response" })
  @ApiContract({ operationId: "createProjectGoal", requestSchema: createGoalRequestSchema, responseSchema: goalSchema })
  create(@Param("id") id: string, @Body(new ZodValidationPipe(createGoalRequestSchema)) body: CreateGoalRequest): Promise<Goal> {
    return this.service.createGoal(id, body);
  }

  // Abandon: no reason is required, but the audit row is the record.
  @Patch("projects/:id/goals/:goalId")
  @RequirePermission("task:create")
  @ProjectParam("id")
  @Audit({ action: "goal.abandoned", resourceType: "goal", paramName: "goalId" })
  @ApiContract({ operationId: "updateProjectGoal", requestSchema: updateGoalRequestSchema, responseSchema: goalSchema })
  update(
    @Param("id") id: string,
    @Param("goalId") goalId: string,
    @Body(new ZodValidationPipe(updateGoalRequestSchema)) body: UpdateGoalRequest,
  ): Promise<Goal> {
    return this.service.updateGoal(id, goalId, body);
  }
}
